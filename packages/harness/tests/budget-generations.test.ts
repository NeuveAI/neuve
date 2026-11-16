// Why: mixed builds on one machine. A newer client must be admitted by every older host, an older client by the new one, and a refusal from a host that knows readings must stand.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostBudget, localBudget } from "../src/budget/local.ts";
import type { Request } from "../src/budget/scheduler.ts";
import { reviewPriority } from "../src/pi/priority.ts";
import { FrozenRequest, frozenHost } from "./fixtures/budget-host-v1.ts";

const account = "a".repeat(64);
const reading: Request = {
  owner: "run-1",
  priority: reviewPriority("lane-review", false, 7),
  resource: { kind: "provider", account },
};
const stripped = FrozenRequest.parse({
  owner: "run-1",
  priority: { class: "interactive", position: "new", stage: 50 },
  resource: { kind: "provider", account },
});
const scratch = () => mkdtempSync(join(tmpdir(), "budget-generations-"));

test("a strict host from before 10 November admits a reading after asking its capacity, without the reading key", async () => {
  const directory = scratch();
  const host = await frozenHost(directory, "strict");
  try {
    const grant = await localBudget(directory).admit(reading);
    await grant.release();
    expect(host.exchanges).toEqual(["admit", "capacity", "admit"]);
    expect(host.admitted).toEqual([stripped]);
  } finally {
    await host.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a compatible-read host admits a reading in one exchange", async () => {
  const directory = scratch();
  const host = await frozenHost(directory, "compatible");
  try {
    const grant = await localBudget(directory).admit(reading);
    await grant.release();
    expect(host.exchanges).toEqual(["admit"]);
    expect(host.admitted).toEqual([stripped]);
  } finally {
    await host.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

// A resent reading would get in as a turn and pass every waiting reading, just when the queue is full.
test("a host that knows readings and refuses one is asked its capacity, and the refusal stands", async () => {
  const directory = scratch();
  const host = await frozenHost(directory, "refusing");
  try {
    await expect(localBudget(directory).admit(reading)).rejects.toThrow(
      "Machine budget refused request",
    );
    expect(host.exchanges).toEqual(["admit", "capacity"]);
    expect(host.admitted).toEqual([]);
  } finally {
    await host.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a refused request without a reading is not sent again", async () => {
  const directory = scratch();
  const host = await frozenHost(directory, "refusing");
  try {
    await expect(
      localBudget(directory).admit({
        ...reading,
        priority: reviewPriority("find", true),
      }),
    ).rejects.toThrow("Machine budget refused request");
    expect(host.exchanges).toEqual(["admit"]);
  } finally {
    await host.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("an older client's admit, without a reading key, is admitted by the new host", async () => {
  const directory = scratch();
  const host = await hostBudget({ directory, threads: 2, fixed: 4 });
  if (!host) throw new Error("scratch budget host was already claimed");
  const socket = createConnection(join(directory, "budget.sock"));
  try {
    const reply = await new Promise<string>((resolve, reject) => {
      socket.once("error", reject);
      socket.once("data", (bytes) => resolve(bytes.toString()));
      socket.once("connect", () =>
        socket.write(
          `${JSON.stringify({ version: 1, kind: "admit", request: FrozenRequest.parse(stripped) })}\n`,
        ),
      );
    });
    expect(JSON.parse(reply)).toMatchObject({ kind: "grant", permits: 1 });
    expect((await host.scheduler.observe()).providerHeld).toBe(1);
    expect((await host.scheduler.capacity()).readings).toBe(1);
  } finally {
    socket.destroy();
    await host.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
