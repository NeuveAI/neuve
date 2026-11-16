// Why: commands and recovery must work at every boundary of the early lifetime claim.
import { expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawn as spawnNode } from "node:child_process";
import { Readable } from "node:stream";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Effect } from "effect";
import { z } from "zod";
import {
  Worker,
  resolveStoreLocation,
  storeLocationIn,
} from "@neuve/records-core";
import { claimWorkerLock } from "../../../packages/records-core/src/worker-socket.ts";

import { workerSuite } from "../../../packages/records-core/tests/worker-suite.ts";
import { markSetUp } from "./fixtures/set-up.ts";

const workers = workerSuite();
const cli = resolve(import.meta.dir, "../src/cli.ts");
const worker = resolve(import.meta.dir, "fixtures/startup-worker.ts");
const review = resolve(import.meta.dir, "fixtures/startup-review.ts");
const steps = [
  "locked",
  "reserved",
  "opening",
  "transaction",
  "accepted",
  "ready",
] as const;
const Wire = z.object({ event: z.string(), pid: z.number().int().positive() });
const setup = async (step: string) => {
  const owner = await workers.start();
  const root = mkdtempSync(join(tmpdir(), "startup-lifecycle-"));
  const settings = join(root, "settings.json");
  writeFileSync(settings, JSON.stringify({ version: 1 }));
  const repo = join(root, "repo");
  const control = `/tmp/startup-${process.pid}-${Math.random().toString(16).slice(2)}.sock`;
  const sockets = new Set<Socket>();
  const children: Array<{
    kill(signal: NodeJS.Signals): unknown;
    exited: Promise<number>;
  }> = [];
  const messages: Array<{ event: string; socket: Socket }> = [];
  const waiters = new Map<string, (socket: Socket) => void>();
  const next = (event: string) => {
    const index = messages.findIndex((message) => message.event === event);
    if (index >= 0)
      return Promise.resolve(messages.splice(index, 1)[0]!.socket);
    return new Promise<Socket>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`missing ${event}`)),
        6000,
      );
      waiters.set(event, (socket) => {
        clearTimeout(timer);
        resolve(socket);
      });
    });
  };
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    let buffer = "";
    socket.on("data", (data) => {
      buffer += data;
      if (!buffer.includes("\n")) return;
      const message = Wire.parse(JSON.parse(buffer.trim()));
      if (process.env.FRESH_STORE_DEBUG)
        console.error("startup", step, message.event, message.pid);
      if (message.event === "boot") socket.end("go\n");
      else {
        const event =
          message.event === "exited" ? `exited:${message.pid}` : message.event;
        const waiter = waiters.get(event);
        if (waiter) {
          waiters.delete(event);
          waiter(socket);
        } else messages.push({ event, socket });
        if (
          message.event === "connection" ||
          message.event === "bound" ||
          message.event === "exited"
        )
          socket.end("go\n");
      }
      buffer = "";
    });
  });
  await new Promise<void>((resolve) => server.listen(control, resolve));
  const git = (...args: string[]) => {
    const result = Bun.spawnSync([
      "git",
      "-c",
      "core.hooksPath=/dev/null",
      "-C",
      repo,
      ...args,
    ]);
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    return result.stdout.toString().trim();
  };
  expect(Bun.spawnSync(["git", "init", "-q", repo]).exitCode).toBe(0);
  // Reviews refuse a repository until `neuve setup` has run there.
  await markSetUp(repo);
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.com");
  writeFileSync(join(repo, "file.txt"), "before\n");
  git("add", ".");
  git("commit", "-qm", "base");
  const base = git("rev-parse", "HEAD");
  writeFileSync(join(repo, "file.txt"), "after\n");
  git("add", ".");
  git("commit", "-qm", "head");
  const range = `${base}..${git("rev-parse", "HEAD")}`;
  const location = await Effect.runPromise(resolveStoreLocation(repo));
  const path = await Effect.runPromise(Worker.socketPathFor(location));
  const spawn = (
    args: string[],
    env = {},
    ipc?: (message: unknown) => void,
  ) => {
    const child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        "--preload",
        resolve(import.meta.dir, "fixtures/startup-settings.ts"),
        ...args,
      ],
      {
        detached: true,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          ...owner.env,
          ANTHROPIC_API_KEY: "fixture-never-used",
          FRESH_STORE_SETTINGS: settings,
          STARTUP_CONTROL: control,
          STARTUP_STEP: step,
          ...env,
        },
        ...(ipc ? { ipc } : {}),
      },
    );
    owner.child(child.pid);
    children.push(child);
    const output = Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return {
      child,
      result: async () => {
        const [stdout, stderr] = await output;
        return { code: await child.exited, stdout, stderr };
      },
    };
  };
  const close = async () => {
    await owner.close();
    for (const child of children) child.kill("SIGTERM");
    for (const socket of sockets) socket.destroy();
    await Promise.all(children.map((child) => child.exited));
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
    rmSync(control, { force: true });
  };
  try {
    const child = spawnNode(
      process.execPath,
      ["--no-env-file", worker, "--repo", repo],
      {
        env: {
          ...process.env,
          ...owner.env,
          FRESH_STORE_SETTINGS: settings,
          STARTUP_CONTROL: control,
          STARTUP_STEP: step,
          NEUVE_WORKER_READY_FD: "3",
        },
        detached: true,
        stdio: ["ignore", "pipe", "pipe", "pipe"],
      },
    );
    owner.child(child.pid);
    const pid = z.number().int().positive().parse(child.pid);
    const exited = new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolve(code ?? 128));
    });
    const owned = {
      pid,
      kill: (signal: NodeJS.Signals) => child.kill(signal),
      exited,
    };
    children.push(owned);
    let stdout = "",
      stderr = "",
      readiness = "";
    child.stdout?.on("data", (data) => {
      stdout += data;
    });
    child.stderr?.on("data", (data) => {
      stderr += data;
    });
    const pipe = child.stdio[3];
    if (!(pipe instanceof Readable)) throw new Error("readiness pipe missing");
    pipe.on("data", (data) => {
      readiness += data;
    });
    const readyClosed = new Promise<void>((resolve) =>
      pipe.once("end", resolve),
    );
    const started = {
      child: owned,
      result: async () => ({ code: await exited, stdout, stderr }),
    };
    const gate = await next(step);
    if (step === "ready") await readyClosed;
    return {
      repo,
      location,
      path,
      spawn,
      started,
      gate,
      next,
      range,
      close,
      readiness: () => readiness,
    };
  } catch (error) {
    await close();
    throw error;
  }
};

for (const step of steps) {
  test(
    `worker status and stop at startup ${step}`,
    async () => {
      const s = await setup(step);
      try {
        const accepted = step === "accepted" || step === "ready";
        expect(s.readiness()).toBe(step === "ready" ? "ready\n" : "");
        // CLI status is uncertain until acceptance; no row or bound listener manufactures acceptance.
        const status = await s
          .spawn([cli, "worker", "status", "--repo", s.repo, "--json"])
          .result();
        expect(status.code, status.stderr).toBe(0);
        const state = JSON.parse(status.stdout);
        if (process.env.FRESH_STORE_DEBUG)
          console.error(
            "startup status",
            step,
            status.code,
            state.socketState,
            state.responding,
            s.readiness().trim(),
          );
        expect(state.responding).toBe(accepted);
        expect(state.socketState).toBe(
          step === "locked" ? "unreachable" : "live",
        );
        if (accepted) expect(state.worker.pid).toBe(s.started.child.pid);
        else expect(state.worker).toBeNull();
        if (step !== "locked") await s.next("connection");
        const stop = s.spawn([cli, "worker", "stop", "--repo", s.repo]);
        if (step === "locked") {
          // Before bind there is no connection on which stop could wait. This is main's behavior.
          const result = await stop.result();
          expect(result.code, result.stderr).toBe(0);
          expect(result.stdout).toContain("No worker is running.");
          const reserved = s.next("bound");
          s.gate.end("go\n");
          await reserved;
          const stopping = Worker.stopWorker(s.path, AbortSignal.timeout(5000));
          await s.next("connection");
          expect((await stopping)._tag).toBe("Answered");
        } else {
          await s.next("connection");
          s.gate.end("go\n");
          const result = await stop.result();
          expect(result.code, result.stderr).toBe(0);
          expect(result.stdout).toContain("Worker stopped.");
        }
        expect((await s.started.result()).code).toBe(0);
        expect(existsSync(s.path)).toBe(false);
      } finally {
        await s.close();
      }
    },
    // Status exhausts SQLite's five-second busy timeout while acceptance holds the transaction.
    step === "transaction" ? 15_000 : 5_000,
  );
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    test(`plain review recovers after ${signal} at startup ${step}`, async () => {
      // Starts, kills and replaces real workers, then checks subscription and cleanup.
      const s = await setup(step);
      try {
        s.started.child.kill(signal);
        await s.started.child.exited;
        const lock = await Effect.runPromise(
          claimWorkerLock(
            (await Effect.runPromise(Worker.workerPathsFor(s.location))).lock,
          ),
        );
        expect(lock).toBeDefined();
        lock?.close();
        let subscribed = false;
        const spawned = new Set<number>();
        const recovered = s.spawn(
          [review, s.repo, s.range],
          { STARTUP_STEP: "" },
          (message) => {
            if (message === "subscribed") subscribed = true;
            else {
              const value = z
                .object({
                  event: z.literal("spawned"),
                  pid: z.number().int().positive(),
                })
                .parse(message);
              spawned.add(value.pid);
            }
          },
        );
        const result = await recovered.result();
        expect(result.code, result.stderr).toBe(0);
        expect(subscribed).toBe(true);
        if (process.env.FRESH_STORE_DEBUG)
          console.error(
            "startup recovered",
            step,
            signal,
            "subscription reached",
          );
        const status = await Effect.runPromise(
          Worker.reachWorker(s.path, "status"),
        );
        expect(status._tag).toBe("Answered");
        if (status._tag !== "Answered")
          throw new Error("replacement worker did not answer");
        const winner = z
          .object({ pid: z.number().int().positive() })
          .parse(JSON.parse(status.reply)).pid;
        expect(winner).not.toBe(s.started.child.pid);
        for (const pid of spawned)
          if (pid !== winner) await s.next(`exited:${pid}`);
        const db = new DatabaseSync(s.location.database, { readOnly: true });
        try {
          expect(
            db.prepare("SELECT count(*) AS n FROM worker_state").get(),
          ).toEqual({ n: 1 });
          expect(
            db.prepare("SELECT count(*) AS n FROM worker_lock_claim").get(),
          ).toEqual({ n: 1 });
        } finally {
          db.close();
        }
        await Worker.stopWorker(s.path, AbortSignal.timeout(5000));
        await s.next(`exited:${winner}`);
        expect(existsSync(s.path)).toBe(false);
        const stopped = new DatabaseSync(s.location.database, {
          readOnly: true,
        });
        try {
          expect(
            stopped.prepare("SELECT count(*) AS n FROM worker_state").get(),
          ).toEqual({ n: 0 });
          expect(
            stopped
              .prepare("SELECT count(*) AS n FROM worker_lock_claim")
              .get(),
          ).toEqual({ n: 0 });
        } finally {
          stopped.close();
        }
      } finally {
        await s.close();
      }
    }, 15_000);
  }
}

// Why: a slow first start must be followed through its own acknowledgement, without another spawn.
test("fresh plain review waits for its one slow worker and reaches subscription", async () => {
  const s = await setup("locked");
  try {
    s.started.child.kill("SIGKILL");
    await s.started.child.exited;
    expect(existsSync(s.location.database)).toBe(false);
    const locked = s.next("locked");
    const spawned: number[] = [];
    let subscribed = false;
    const running = s.spawn(
      [review, s.repo, s.range],
      { STARTUP_OBSERVE_READY: "1" },
      (message) => {
        if (message === "awaiting-startup")
          void locked.then((gate) => gate.end("go\n"));
        else if (message === "subscribed") subscribed = true;
        else spawned.push(z.object({ pid: z.number() }).parse(message).pid);
      },
    );
    await locked;
    const result = await running.result();
    if (process.env.FRESH_STORE_DEBUG)
      console.error(
        "one start",
        JSON.stringify({ ...result, spawned, subscribed }),
      );
    expect(result.code, result.stderr).toBe(0);
    expect(spawned).toHaveLength(1);
    expect(subscribed).toBe(true);
  } finally {
    await s.close();
  }
}, 15_000);

// Why: an unused readiness acknowledgement and deadline must not keep a short command alive.
for (const mode of ["--detach", "--admit-only"])
  test(`fresh review ${mode} exits while its first worker is still locked`, async () => {
    const s = await setup("locked");
    try {
      s.started.child.kill("SIGKILL");
      await s.started.child.exited;
      expect(existsSync(s.location.database)).toBe(false);
      const locked = s.next("locked");
      const spawned: number[] = [];
      const running = s.spawn(
        [review, s.repo, s.range, mode],
        { STARTUP_NATURAL_EXIT: "1" },
        (message) =>
          spawned.push(z.object({ pid: z.number() }).parse(message).pid),
      );
      await locked;
      const began = performance.now();
      const result = await running.result();
      const elapsed = performance.now() - began;
      if (process.env.FRESH_STORE_DEBUG)
        console.error(
          "prompt exit",
          JSON.stringify({ mode, ...result, elapsed, spawned }),
        );
      expect(result.code, result.stderr).toBe(0);
      expect(elapsed).toBeLessThan(2000);
      expect(spawned).toHaveLength(1);
    } finally {
      await s.close();
    }
  }, 5_000);

// Why: a refused contender from a separate command must reach the public CLI with actionable text.
test("public review reports startup refusal and can be rerun after acceptance", async () => {
  const s = await setup("locked");
  try {
    const result = await s
      .spawn([review, s.repo, s.range, "--public-cli"], { STARTUP_STEP: "" })
      .result();
    expect(result.code).toBe(2);
    expect(result.stderr).toBe(
      "neuve: The background worker didn't finish starting.\nRun the command again.\n",
    );
    expect(result.stderr.split("\n")).not.toContain("neuve: ");
    if (process.env.FRESH_STORE_DEBUG)
      console.error("public startup refusal", JSON.stringify(result));
    s.gate.end("go\n");
    await s.next("bound");
    expect(
      (
        await Effect.runPromise(
          Worker.reachWorker(s.path, "status", "10 seconds"),
        )
      )._tag,
    ).toBe("Answered");
    let subscribed = false;
    const retry = await s
      .spawn(
        [review, s.repo, s.range, "--public-cli"],
        { STARTUP_STEP: "" },
        (message) => {
          if (message === "subscribed") subscribed = true;
        },
      )
      .result();
    expect(retry.code).toBe(2);
    expect(retry.stderr).toBe("neuve: subscription reached\n");
    expect(subscribed).toBe(true);
    await Worker.stopWorker(s.path, AbortSignal.timeout(5000));
    expect((await s.started.result()).code).toBe(0);
  } finally {
    await s.close();
  }
}, 15_000);

test("worker run on corrupt Records exits nonzero with its database cause on stderr", async () => {
  const owner = await workers.start();
  const root = mkdtempSync(join(tmpdir(), "worker-corrupt-"));
  const settings = join(root, "settings.json");
  writeFileSync(settings, JSON.stringify({ version: 1 }));
  const location = storeLocationIn(root);
  mkdirSync(location.directory, { recursive: true });
  writeFileSync(location.database, "not a sqlite database");
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      "--preload",
      resolve(import.meta.dir, "fixtures/startup-settings.ts"),
      "--preload",
      resolve(
        import.meta.dir,
        "../../../packages/records-core/tests/fixture-worker-lifetime.ts",
      ),
      cli,
      "worker",
      "run",
      "--store",
      location.directory,
      "--idle-seconds",
      "1",
    ],
    {
      detached: true,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ...owner.env, FRESH_STORE_SETTINGS: settings },
    },
  );
  owner.child(child.pid);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (process.env.FRESH_STORE_DEBUG)
      console.error("corrupt worker", JSON.stringify({ code, stdout, stderr }));
    expect(code, stdout).not.toBe(0);
    expect(stderr).toContain("file is not a database");
  } finally {
    child.kill();
    await child.exited;
    rmSync(root, { recursive: true, force: true });
  }
});
