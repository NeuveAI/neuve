// The connect gate's bound on a host's accept queue, against hosts that stall, never answer or go.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localBudget } from "../src/budget/local.ts";
import type { Budget, Grant } from "../src/budget/scheduler.ts";
import { reviewPriority } from "../src/pi/priority.ts";

const until = async (done: () => Promise<boolean>) => {
  for (let n = 0; n < 3_000 && !(await done()); n++) await Bun.sleep(10);
};

/** `count` provider admissions issued in one tick; each ends granted or with its error's message. */
const admitMany = (client: Budget, count: number, signal?: AbortSignal) => {
  const granted: Grant[] = [];
  const failures: string[] = [];
  const settled = Promise.all(
    Array.from({ length: count }, (_, n) =>
      client
        .admit(
          {
            owner: "run-1",
            priority: reviewPriority("assess", false, n),
            resource: { kind: "provider", account: "a".repeat(64) },
          },
          signal,
        )
        .then(
          (grant) => granted.push(grant),
          (cause: unknown) =>
            failures.push(cause instanceof Error ? cause.message : "?"),
        ),
    ),
  );
  return { granted, failures, settled };
};

/** The fixture host in its own process; `block` returns once its loop has started a 300 ms stall. */
const stallingHost = async (directory: string) => {
  const host = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, "fixtures/budget-host-stall.ts"),
      directory,
    ],
    { stdin: "pipe", stdout: "pipe", stderr: "inherit" },
  );
  const lines = host.stdout.getReader();
  const line = async () => new TextDecoder().decode((await lines.read()).value);
  expect(await line()).toContain("ready");
  return {
    block: async () => {
      host.stdin.write("block\n");
      host.stdin.flush();
      expect(await line()).toContain("blocking");
    },
    stop: async () => {
      host.stdin.end();
      host.kill();
      await host.exited;
    },
  };
};

/** Accepts and reads, never answers: nothing it accepted is ever confirmed. */
const silentHost = async (directory: string) => {
  const accepted: Socket[] = [];
  const kinds: string[] = [];
  let barrier: Socket | undefined;
  const server = createServer((socket) => {
    accepted.push(socket);
    socket.once("data", (chunk) => {
      const kind = JSON.parse(chunk.toString().split("\n")[0] ?? "{}").kind;
      kinds.push(kind);
      if (kind === "capacity") barrier = socket;
    });
  });
  await new Promise<void>((resolve) =>
    server.listen(join(directory, "budget.sock"), resolve),
  );
  return {
    accepted,
    kinds,
    endBarrier: () => barrier?.destroy(),
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        for (const socket of accepted) socket.destroy();
      }),
  };
};

const held = (client: Budget, waiting: number, providerHeld: number) =>
  client.observe().then(
    (n) => n.waiting === waiting && n.providerHeld === providerHeld,
    () => false,
  );

// Why: a host busy for a moment must not push a burst onto the floor.
test("500 admissions sent while the host's loop is blocked all reach it", async () => {
  const directory = mkdtempSync(join(tmpdir(), "budget-stall-"));
  const host = await stallingHost(directory);
  const client = localBudget(directory);
  const abort = new AbortController();
  let burst: ReturnType<typeof admitMany> | undefined;
  try {
    await host.block();
    const sent = (burst = admitMany(client, 500, abort.signal));
    // Four of the eight slots: a run that has not started leaves four free for its first steps.
    await until(
      async () => sent.failures.length > 0 || (await held(client, 496, 4)),
    );
    expect(sent.failures).toHaveLength(0);
    expect(await client.observe()).toMatchObject({
      waiting: 496,
      providerHeld: 4,
    });
    expect(sent.granted).toHaveLength(4);
    abort.abort();
    await sent.settled;
    await until(async () => (await client.observe()).waiting === 0);
    expect((await client.observe()).waiting).toBe(0);
  } finally {
    abort.abort();
    for (const grant of burst?.granted ?? []) await grant.release();
    await host.stop();
    rmSync(directory, { recursive: true, force: true });
  }
}, 60_000);

// Why: when the host goes while callers wait at the gate, they must fail into recovery, not hang.
test("a barrier that ends without a reply lets the waiters go, and a closed host fails them with the connection error", async () => {
  const directory = mkdtempSync(join(tmpdir(), "budget-barrier-"));
  const host = await silentHost(directory);
  const burst = admitMany(localBudget(directory), 40);
  try {
    await until(async () => host.kinds.length >= 33);
    expect(host.kinds.filter((k) => k === "admit")).toHaveLength(32);
    expect(host.kinds.filter((k) => k === "capacity")).toHaveLength(1);
    // Only the barrier ends: the gate takes the host for gone and lets the eight waiters connect.
    host.endBarrier();
    await until(async () => host.kinds.length >= 41);
    expect(host.kinds.filter((k) => k === "admit")).toHaveLength(40);
    await host.close();
    await burst.settled;
    expect(burst.failures).toHaveLength(40);
    expect(
      burst.failures.every((m) => m.startsWith("Machine budget connection")),
    ).toBe(true);
  } finally {
    await host.close();
    rmSync(directory, { recursive: true, force: true });
  }
}, 60_000);

// Why: a cancelled run must not spend the accept queue.
test("aborting 500 admissions at the gate opens no further connection", async () => {
  const directory = mkdtempSync(join(tmpdir(), "budget-abort-"));
  const host = await silentHost(directory);
  const abort = new AbortController();
  const burst = admitMany(localBudget(directory), 500, abort.signal);
  try {
    await until(async () => host.kinds.length >= 33);
    expect(host.accepted).toHaveLength(33);
    abort.abort();
    await burst.settled;
    expect(burst.failures).toHaveLength(500);
    expect(burst.failures.every((m) => m === "Budget request aborted")).toBe(
      true,
    );
    // A connection the abort opened would reach this host within a few turns of its loop.
    await Bun.sleep(100);
    expect(host.accepted).toHaveLength(33);
  } finally {
    await host.close();
    rmSync(directory, { recursive: true, force: true });
  }
}, 60_000);

// Why: a cancelled run must not spend the accept queue.
test("a burst aborted while the host is blocked leaves room for the next 100 admissions", async () => {
  const directory = mkdtempSync(join(tmpdir(), "budget-abort-stall-"));
  const host = await stallingHost(directory);
  const client = localBudget(directory);
  const abort = new AbortController();
  let fresh: ReturnType<typeof admitMany> | undefined;
  try {
    await host.block();
    const cancelled = admitMany(client, 500, abort.signal);
    await Bun.sleep(5);
    abort.abort();
    const next = (fresh = admitMany(client, 100));
    await cancelled.settled;
    expect(cancelled.failures).toHaveLength(500);
    // Four of the eight slots: a run that has not started leaves four free for its first steps.
    await until(
      async () => next.failures.length > 0 || (await held(client, 96, 4)),
    );
    expect(next.failures).toHaveLength(0);
    expect(await client.observe()).toMatchObject({
      waiting: 96,
      providerHeld: 4,
    });
  } finally {
    abort.abort();
    for (const grant of fresh?.granted ?? []) await grant.release();
    await host.stop();
    rmSync(directory, { recursive: true, force: true });
  }
}, 60_000);
