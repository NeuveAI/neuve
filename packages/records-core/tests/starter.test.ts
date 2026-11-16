// Why: fresh-store reads must distinguish an accepting worker from a contender refusing legacy state.
import { afterEach, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { DatabaseSync } from "node:sqlite";
import {
  chmodSync,
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import * as Socket from "../src/worker-socket.ts";
import {
  ensureWorker,
  ensureWorkerAt,
  WorkerSpawnFailed,
} from "../src/starter.ts";
import { freshLocation, removeTemporaryDirectories, runOn } from "./support.ts";

import { workerSuite } from "./worker-suite.ts";

const workers = workerSuite();
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanups.splice(0).reverse()) close();
  removeTemporaryDirectories();
});
const setup = async (legacy: "absent" | "empty" | "current" | "none") => {
  const location = freshLocation();
  await runOn(location, Effect.void);
  const path = await Effect.runPromise(Socket.socketPathFor(location));
  const db = new DatabaseSync(location.database);
  const at = "2026-11-11T00:00:00.000Z";
  if (legacy !== "none")
    db.prepare(`INSERT INTO worker_state VALUES (1, ?, ?, ?, ?, 'test')`).run(
      process.pid,
      path,
      at,
      at,
    );
  if (legacy === "absent") db.exec("DROP TABLE worker_lock_claim");
  if (legacy === "current") db.exec("INSERT INTO worker_lock_claim VALUES (1)");
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();
  expect(existsSync(`${location.database}-wal`)).toBe(false);
  return { location, path, at };
};
const listen = (path: string, reply: string) => {
  const commands: string[] = [];
  const server = Bun.listen({
    unix: path,
    socket: {
      data(socket, bytes) {
        for (const command of bytes.toString().trim().split("\n")) {
          commands.push(command);
          socket.write(`${command === "wake" ? "ok" : reply}\n`);
        }
      },
    },
  });
  cleanups.push(() => server.stop(true));
  return commands;
};
const changeDuringRead = (
  database: string,
  afterChange: () => void = () => {},
) => {
  let writer: Database | undefined;
  const original = DatabaseSync.prototype.exec;
  const hook = spyOn(DatabaseSync.prototype, "exec").mockImplementation(
    function (this: DatabaseSync, query: string) {
      const result = original.call(this, query);
      if (query === "BEGIN" && writer === undefined) {
        writer = new Database(database);
        writer.exec("CREATE TABLE race_write (id INTEGER)");
        afterChange();
      }
      return result;
    },
  );
  cleanups.push(() => {
    hook.mockRestore();
    writer?.close();
  });
};

for (const marker of ["absent", "empty"] as const) {
  test(`F2: main's unmarked claim refuses with ${marker} marker table and no listener`, async () => {
    const { location } = await setup(marker);
    const result = await Effect.runPromise(
      Effect.result(
        ensureWorkerAt(location, { repository: location.directory }),
      ),
    );
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure")
      expect(result.failure._tag).toBe("OlderWorkerHeld");
  });
  for (const listening of [false, true])
    test(`F2: changed read with ${marker} marker and ${listening ? "legacy" : "absent"} listener refuses despite contender lock`, async () => {
      const { location, path } = await setup(marker);
      const commands = listening ? listen(path, "legacy") : [];
      const lock = await Effect.runPromise(
        Socket.claimWorkerLock(
          (await Effect.runPromise(Socket.workerPathsFor(location))).lock,
        ),
      );
      expect(lock).toBeDefined();
      cleanups.push(() => lock?.close());
      changeDuringRead(location.database);
      const result = await Effect.runPromise(
        Effect.result(
          ensureWorkerAt(location, {
            repository: location.directory,
            waitForReady: true,
          }),
        ),
      );
      expect(result._tag).toBe("Failure");
      expect(commands).not.toContain("wake");
      const db = new Database(location.database, { readonly: true });
      try {
        expect(
          db.query("SELECT last_progress FROM worker_state").get(),
        ).toEqual({ last_progress: "test" });
      } finally {
        db.close();
      }
      if ("startupMayAcknowledge" in Socket)
        expect(
          await Effect.runPromise(
            Socket.startupMayAcknowledge(location, path, false),
          ),
        ).toBe(false);
      expect(commands).not.toContain("wake");
    });
}

test("F2: changed read can wake a status-confirmed accepted current claim", async () => {
  const { location, path, at } = await setup("current");
  const commands = listen(
    path,
    JSON.stringify({ pid: process.pid, socket: path, startedAt: at }),
  );
  const lock = await Effect.runPromise(
    Socket.claimWorkerLock(
      (await Effect.runPromise(Socket.workerPathsFor(location))).lock,
    ),
  );
  cleanups.push(() => lock?.close());
  changeDuringRead(location.database);
  expect(
    await Effect.runPromise(
      ensureWorkerAt(location, { repository: location.directory }),
    ),
  ).toEqual({ status: "running", socket: path });
  expect(commands).toEqual(["status", "wake"]);
});

test("readiness narrowing: refused contenders need matching accepted current rows", async () => {
  const { location, path, at } = await setup("current");
  const commands = listen(
    path,
    JSON.stringify({ pid: process.pid, socket: path, startedAt: at }),
  );
  const db = new Database(location.database);
  cleanups.push(() => db.close());
  db.exec("CREATE TABLE keep_wal (id INTEGER)");
  expect(
    await Effect.runPromise(Socket.startupMayAcknowledge(location, path, true)),
  ).toBe(true);
  expect(
    await Effect.runPromise(
      Socket.startupMayAcknowledge(location, path, false),
    ),
  ).toBe(true);
  db.exec("DELETE FROM worker_lock_claim");
  expect(
    await Effect.runPromise(
      Socket.startupMayAcknowledge(location, path, false),
    ),
  ).toBe(false);
  db.exec(
    "INSERT INTO worker_lock_claim VALUES (1); UPDATE worker_state SET started_at='another-start'",
  );
  expect(
    await Effect.runPromise(
      Socket.startupMayAcknowledge(location, path, false),
    ),
  ).toBe(false);
  expect(commands).toEqual(["status", "status", "status"]);
});

const tree = (directory: string): unknown =>
  readdirSync(directory)
    .sort()
    .map((name) => {
      const path = join(directory, name),
        stat = lstatSync(path);
      return [
        name,
        stat.mode,
        stat.isDirectory() ? tree(path) : readFileSync(path).toString("hex"),
      ];
    });
for (const long of [false, true])
  test(`F3: read-only legacy diagnosis preserves a 0400 lifetime file and creates nothing, ${long ? "long" : "short"} path`, async () => {
    const { location } = await setup("none");
    const selected = long
      ? { ...location, directory: join(location.directory, "long".repeat(45)) }
      : location;
    const socket =
      Socket.socketPathReadOnly?.(selected) ??
      (await Effect.runPromise(Socket.socketPathFor(selected)));
    const fallback = socket.slice(0, socket.lastIndexOf("/"));
    const fallbackBefore = existsSync(fallback)
      ? lstatSync(fallback).mode
      : undefined;
    if (fallbackBefore === undefined) {
      mkdirSync(fallback, { mode: 0o700 });
      cleanups.push(() => rmSync(fallback, { recursive: true }));
    }
    const lifetime = `${socket}.sqlite`;
    cleanups.push(() => rmSync(lifetime, { force: true }));
    const lock = new Database(lifetime, { create: true });
    lock.exec("CREATE TABLE lifetime (id INTEGER)");
    lock.close();
    chmodSync(lifetime, 0o400);
    const lifetimeBytes = readFileSync(lifetime).toString("hex");
    const before = tree(location.directory);
    const fallbackPrepared = lstatSync(fallback).mode;
    expect(await Effect.runPromise(Socket.hasLegacyWorkerClaim(selected))).toBe(
      false,
    );
    expect(tree(location.directory)).toEqual(before);
    expect(existsSync(fallback) ? lstatSync(fallback).mode : undefined).toBe(
      fallbackPrepared,
    );
    let during: unknown;
    changeDuringRead(location.database, () => {
      during = tree(location.directory);
    });
    const result = await Effect.runPromise(
      Effect.result(Socket.hasLegacyWorkerClaim(selected)),
    );
    expect(tree(location.directory)).toEqual(during);
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure")
      expect(result.failure._tag).toBe("StoreChangedDuringRead");
    expect(lstatSync(lifetime).mode & 0o777).toBe(0o400);
    expect(readFileSync(lifetime).toString("hex")).toBe(lifetimeBytes);
  });

// Why: the readiness pipe must describe acceptance even when the spawned child loses its claim.
for (const accepted of [false, true])
  test(`readiness narrowing: real refused child ${accepted ? "acknowledges an accepted current winner" : "does not acknowledge a legacy listener"}`, async () => {
    const { location, path, at } = await setup(accepted ? "current" : "empty");
    const commands = listen(
      path,
      accepted
        ? JSON.stringify({ pid: process.pid, socket: path, startedAt: at })
        : "legacy",
    );
    const db = new Database(location.database);
    db.exec("CREATE TABLE live_wal (id INTEGER)");
    cleanups.push(() => db.close());
    const lock = await Effect.runPromise(
      Socket.claimWorkerLock(
        (await Effect.runPromise(Socket.workerPathsFor(location))).lock,
      ),
    );
    cleanups.push(() => lock?.close());
    const owner = await workers.start();
    const { spawn } = await import("node:child_process");
    const { dirname } = await import("node:path");
    const child = spawn(
      process.execPath,
      [
        join(import.meta.dir, "fixtures/run-worker.ts"),
        dirname(location.directory),
        "100",
      ],
      {
        detached: true,
        env: { ...process.env, ...owner.env, NEUVE_WORKER_READY_FD: "3" },
        stdio: ["ignore", "pipe", "pipe", "pipe"],
      },
    );
    owner.child(child.pid);
    const { Readable } = await import("node:stream");
    const pipe = child.stdio[3];
    if (!(pipe instanceof Readable)) throw new Error("readiness pipe missing");
    let ready = "",
      errors = "";
    pipe.on("data", (chunk) => {
      ready += String(chunk);
    });
    child.stdout?.resume();
    child.stderr?.on("data", (chunk) => {
      errors += String(chunk);
    });
    try {
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });
      expect(code, errors).toBe(0);
      expect(ready).toBe(accepted ? "ready\n" : "");
      expect(commands).not.toContain("wake");
      expect(db.query("SELECT last_progress FROM worker_state").get()).toEqual({
        last_progress: "test",
      });
    } finally {
      child.kill();
      pipe.destroy();
    }
  });

// Why: both starter failure boundaries must carry public copy and retain diagnostic causes.
for (const phase of ["spawn", "readiness"] as const)
  test(`starter ${phase} failure has public copy and a debug cause`, async () => {
    const { location } = await setup("none");
    const owner = await workers.start();
    if (phase === "spawn") mkdirSync(join(location.directory, "worker.log"));
    const result = await Effect.runPromise(
      Effect.result(
        ensureWorkerAt(location, {
          repository: location.directory,
          command: [
            process.execPath,
            "--no-env-file",
            "-e",
            `process.env.NEUVE_FIXTURE_OWNER = ${JSON.stringify(owner.env.NEUVE_FIXTURE_OWNER)}; await import(${JSON.stringify(join(import.meta.dir, "fixture-worker-lifetime.ts"))}); process.exit(0)`,
          ],
          waitForReady: true,
        }),
      ),
    );
    expect(result._tag).toBe("Failure");
    if (result._tag !== "Failure") throw new Error("expected starter failure");
    expect(result.failure).toBeInstanceOf(WorkerSpawnFailed);
    expect(result.failure.message).toBe(
      "The background worker didn't finish starting.\nRun the command again.",
    );
    if (!(result.failure instanceof WorkerSpawnFailed))
      throw new Error("expected WorkerSpawnFailed");
    expect(result.failure.cause).toBeInstanceOf(Error);
    expect(String(result.failure.cause)).toContain(
      phase === "spawn"
        ? "EISDIR"
        : "worker closed before acknowledging startup",
    );
  });

test("starter repository resolution has public copy and a debug cause", async () => {
  const { location } = await setup("none");
  const result = await Effect.runPromise(
    Effect.result(ensureWorker({ repository: location.directory })),
  );
  expect(result._tag).toBe("Failure");
  if (result._tag !== "Failure") throw new Error("expected repository failure");
  expect(result.failure._tag).toBe("RepositoryUnavailable");
  expect(result.failure.message).toBe(
    `${location.directory} is not inside a git repository, so it has no Records store.`,
  );
  expect(result.failure).toHaveProperty("cause");
});
