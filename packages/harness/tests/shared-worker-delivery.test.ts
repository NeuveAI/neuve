import { expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { Effect, Option } from "effect";
import {
  Store,
  resolveStoreLocation,
  Worker,
  JobQueue,
  Starter,
  JOB_POLICIES,
  Blobs,
  SCHEMA_VERSION,
} from "@neuve/records-core";
import { z } from "zod";
import { createConnection } from "node:net";

const Event = z.object({ event: z.string() });
type Event = z.infer<typeof Event>;
const git = (...args: string[]) => {
  const result = Bun.spawnSync([
    "git",
    "-c",
    "core.hooksPath=/dev/null",
    ...args,
  ]);
  if (result.exitCode) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
};
async function setup(prepare = true) {
  const root = mkdtempSync(join(tmpdir(), "p5-"));
  const directory = join(root, "budget");
  mkdirSync(directory, { mode: 0o700 });
  const repository = join(root, "repo");
  git("init", "-q", repository);
  writeFileSync(join(repository, "readme.md"), "fixture\n");
  git("-C", repository, "add", ".");
  git(
    "-C",
    repository,
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@example.test",
    "commit",
    "-qm",
    "fixture",
  );
  const location = await Effect.runPromise(resolveStoreLocation(repository));
  if (prepare)
    await Effect.runPromise(
      Store.prepareForWrite.pipe(
        Effect.provide(Store.layer(location, { create: true })),
        Effect.provide(BunFileSystem.layer),
      ),
    );
  const children: Array<{ stop: () => Promise<void> }> = [];
  function spawn(
    options: object = {},
    path = repository,
    env: Record<string, string> = {},
    fixture = "durable-worker-process.ts",
  ) {
    const events: Event[] = [],
      listeners = new Set<() => void>();
    const child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        join(import.meta.dir, "fixtures", fixture),
      ],
      {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          ...env,
          HOME: root,
          TMPDIR: root,
          NEUVE_BUDGET_DIRECTORY: directory,
          NEUVE_SHARED_TEST: JSON.stringify({
            repository: path,
            ...options,
          }),
        },
      },
    );
    const output = (async () => {
      let buffer = "";
      for await (const chunk of child.stdout) {
        buffer += new TextDecoder().decode(chunk);
        let end: number;
        while ((end = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 1);
          try {
            const parsed = Event.safeParse(JSON.parse(line));
            if (parsed.success) events.push(parsed.data);
          } catch {}
          for (const listener of listeners) listener();
        }
      }
    })();
    const wait = (event: string, after = 0) =>
      new Promise<Event>((resolve, reject) => {
        const inspect = () => {
          const found = events
            .slice(after)
            .find((item) => item.event === event);
          if (found) {
            listeners.delete(inspect);
            resolve(found);
          }
        };
        listeners.add(inspect);
        inspect();
        void child.exited.then(async (code) => {
          await output;
          if (listeners.delete(inspect))
            reject(
              new Error(
                `fixture exited ${code}; events ${JSON.stringify(events)}; ${await new Response(child.stderr).text()}`,
              ),
            );
        });
      });
    const result = {
      child,
      events,
      wait,
      send: (name: string) => {
        child.stdin.write(`${name}\n`);
        child.stdin.flush();
      },
      stop: async () => {
        child.kill("SIGKILL");
        await child.exited;
        await output;
      },
    };
    children.push(result);
    return result;
  }
  const db = () => {
    const database = new Database(location.database);
    database.run("PRAGMA busy_timeout = 5000");
    return database;
  };
  return {
    root,
    directory,
    repository,
    location,
    spawn,
    db,
    close: async () => {
      await Promise.all(children.map((c) => c.stop()));
      rmSync(root, { recursive: true, force: true });
    },
  };
}

const queueProgram = <A, E>(
  s: Awaited<ReturnType<typeof setup>>,
  use: (q: JobQueue.JobQueue["Service"]) => Effect.Effect<A, E>,
) =>
  Effect.runPromise(
    JobQueue.JobQueue.use(use).pipe(
      Effect.provide(JobQueue.layer),
      Effect.provide(Store.layer(s.location, { create: false })),
      Effect.provide(BunFileSystem.layer),
    ),
  );
const enqueue = (s: Awaited<ReturnType<typeof setup>>, key = "first") =>
  queueProgram(s, (q) => q.enqueue({ kind: "review.run@2", dedupeKey: key }));
const inspect = (s: Awaited<ReturnType<typeof setup>>, seq: number) =>
  queueProgram(s, (q) => q.inspect(seq));
async function saturate(s: Awaited<ReturnType<typeof setup>>, path?: string) {
  path ??= await Effect.runPromise(Worker.socketPathFor(s.location));
  const sockets: ReturnType<typeof createConnection>[] = [];
  await Promise.all(
    Array.from(
      { length: 512 },
      () =>
        new Promise<void>((resolve) => {
          const socket = createConnection(path);
          sockets.push(socket);
          const timer = setTimeout(() => {
            socket.destroy();
            resolve();
          }, 2000);
          const finish = () => {
            clearTimeout(timer);
            resolve();
          };
          socket.once("connect", finish);
          socket.once("error", finish);
        }),
    ),
  );
  expect(await Effect.runPromise(Worker.reachWorker(path))).toEqual({
    _tag: "Refused",
    code: "ECONNREFUSED",
  });
  return () => {
    for (const socket of sockets) socket.destroy();
  };
}
const cli = async (
  s: Awaited<ReturnType<typeof setup>>,
  command: string,
  json = false,
) => {
  const child = Bun.spawn(
    [
      process.execPath,
      ...Starter.sourceRunFlags(),
      join(import.meta.dir, "../../../apps/neuve-cli/src/cli.ts"),
      "worker",
      command,
      "--repo",
      s.repository,
      ...(json ? ["--json"] : []),
    ],
    {
      env: {
        ...process.env,
        HOME: s.root,
        TMPDIR: s.root,
        NEUVE_BUDGET_DIRECTORY: s.directory,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, code };
};
// Why: a full live accept queue cannot authorize takeover of a pre-lock worker.
// Skip elsewhere: the full Unix accept backlog returns ECONNREFUSED on macOS.
test.skipIf(process.platform !== "darwin")(
  "a stopped older worker with a full backlog retains attempt one",
  async () => {
    const s = await setup();
    let clear = () => {};
    const job = await enqueue(s);
    const first = s.spawn({}, s.repository, {}, "older-worker-process.ts");
    try {
      await first.wait("run");
      first.child.kill("SIGSTOP");
      // That build listens on the store's legacy socket.
      clear = await saturate(s, join(s.location.directory, "worker.sock"));
      const recovery = await cli(s, "recover");
      expect(recovery.code).toBe(1);
      expect(recovery.stdout).toContain("Records is still open");
      const status = await cli(s, "status");
      expect(status.stdout).toContain("held by an older worker");
      const start = await cli(s, "start");
      expect(start.code).not.toBe(0);
      expect(start.stderr).toContain("held by an older worker");
      const contender = s.spawn();
      const outcome = await Promise.race([
        contender.wait("exit"),
        contender.wait("run"),
      ]);
      expect(outcome.event).toBe("exit");
      const stored = await inspect(s, job.job.seq);
      expect(Option.getOrThrow(stored)).toMatchObject({
        state: "active",
        attempts: 1,
        stalls: 0,
      });
    } finally {
      first.child.kill("SIGCONT");
      clear();
      await s.close();
    }
  },
  60_000,
);

// Why: dropping from another process must retain a notice when its only wake-up is refused.
// Skip elsewhere: the full Unix accept backlog returns ECONNREFUSED on macOS.
test.skipIf(process.platform !== "darwin")(
  "drop notice survives a refused publication",
  async () => {
    const s = await setup();
    let clear = () => {};
    const worker = s.spawn();
    let subscription:
      Awaited<ReturnType<typeof Worker.subscribeJob>> | undefined;
    try {
      await enqueue(s);
      await Effect.runPromise(
        Worker.reachWorker(
          await Effect.runPromise(Worker.socketPathFor(s.location)),
          "wake",
        ),
      );
      await worker.wait("run");
      const waiting = await enqueue(s, "waiting");
      subscription = await Worker.subscribeJob(s.location, waiting.job.seq);
      worker.child.kill("SIGSTOP");
      clear = await saturate(s);
      await queueProgram(s, (q) => q.drop(waiting.job.seq));
      worker.child.kill("SIGCONT");
      clear();
      expect(
        await Promise.race([
          subscription.next(),
          new Promise((resolve) =>
            setTimeout(() => resolve("no notification"), 2000),
          ),
        ]),
      ).toBe("changed");
      const path = await Effect.runPromise(Worker.socketPathFor(s.location));
      expect(
        (await Effect.runPromise(Worker.reachWorker(path, "status")))._tag,
      ).toBe("Answered");
      expect(Option.getOrThrow(await inspect(s, waiting.job.seq)).state).toBe(
        "failed",
      );
    } finally {
      worker.child.kill("SIGCONT");
      clear();
      subscription?.close();
      await s.close();
    }
  },
  60_000,
);

// Why: a crashed pre-lock worker remains visible until explicit recovery proves exclusive access.
test("a killed older worker is reported and explicitly recovered", async () => {
  const s = await setup();
  try {
    const job = await enqueue(s);
    // A marker cannot survive an older build's INSERT, even without a prior claim row.
    const stale = s.db();
    try {
      stale.exec("INSERT INTO worker_lock_claim(id) VALUES (1)");
    } finally {
      stale.close();
    }
    const first = s.spawn({}, s.repository, {}, "older-worker-process.ts");
    await first.wait("run");
    expect(
      await Effect.runPromise(Worker.hasLegacyWorkerClaim(s.location)),
    ).toBe(true);
    await first.stop();
    const status = await cli(s, "status", true);
    expect(status.stdout).toContain("held by an older worker");
    expect(status.stdout).toContain("neuve worker recover");
    const start = await cli(s, "start");
    expect(start.code).not.toBe(0);
    expect(start.stderr).toContain("held by an older worker");
    const contender = s.spawn();
    expect((await contender.wait("exit")).event).toBe("exit");
    expect(Option.getOrThrow(await inspect(s, job.job.seq))).toMatchObject({
      state: "active",
      attempts: 1,
      stalls: 0,
    });
    const recovered = await cli(s, "recover");
    expect(recovered.code).toBe(0);
    expect(recovered.stdout).toContain("exclusive Records access");
    const next = s.spawn();
    await next.wait("run");
    expect(Option.getOrThrow(await inspect(s, job.job.seq))).toMatchObject({
      state: "active",
      attempts: 2,
      stalls: 1,
    });
    const refused = await cli(s, "recover");
    expect(refused.code).toBe(1);
    expect(refused.stdout).toContain("lifetime lock");
    const subscription = await Worker.subscribeJob(s.location, job.job.seq);
    next.send("run");
    expect(await subscription.next()).toBe("changed");
    subscription.close();
    expect(Option.getOrThrow(await inspect(s, job.job.seq)).state).toBe(
      "completed",
    );
  } finally {
    await s.close();
  }
}, 60_000);

for (const outcome of ["completed", "failed", "exhausted"] as const) {
  const failed = outcome !== "completed";
  const exhausted = outcome === "exhausted";
  // Why: a worker finishing its own job must deliver in process even when its listener refused all pokes.
  // Skip elsewhere: the full Unix accept backlog returns ECONNREFUSED on macOS.
  test.skipIf(process.platform !== "darwin")(
    `worker ${outcome} delivers with its own socket saturated`,
    async () => {
      const s = await setup();
      let clear = () => {};
      const job = await enqueue(s);
      if (exhausted) {
        const db = s.db();
        try {
          db.run("UPDATE jobs SET attempts=? WHERE job_seq=?", [
            JOB_POLICIES["review.run@2"].maxAttempts - 1,
            job.job.seq,
          ]);
        } finally {
          db.close();
        }
      }
      const worker = s.spawn({ failed, exhausted });
      let subscription:
        Awaited<ReturnType<typeof Worker.subscribeJob>> | undefined;
      try {
        await worker.wait("run");
        subscription = await Worker.subscribeJob(s.location, job.job.seq);
        worker.child.kill("SIGSTOP");
        clear = await saturate(s);
        worker.send("run");
        worker.child.kill("SIGCONT");
        expect(await subscription.next()).toBe("changed");
        expect(Option.getOrThrow(await inspect(s, job.job.seq)).state).toBe(
          failed ? "failed" : "completed",
        );
        // Registration still precedes the read when delivery occurred before the follower arrived.
        const late = await Worker.subscribeJob(s.location, job.job.seq);
        expect(Option.getOrThrow(await inspect(s, job.job.seq)).state).toBe(
          failed ? "failed" : "completed",
        );
        late.close();
      } finally {
        worker.child.kill("SIGCONT");
        clear();
        subscription?.close();
        await s.close();
      }
    },
    60_000,
  );
}

// Why: failure to persist a pending notice must roll back the terminal state in the same transaction.
test("terminal state and its notice commit or roll back together", async () => {
  const s = await setup();
  try {
    const job = await enqueue(s);
    const db = s.db();
    try {
      db.exec(
        "CREATE TRIGGER reject_notice BEFORE INSERT ON job_notices BEGIN SELECT RAISE(ABORT, 'notice rejected'); END",
      );
    } finally {
      db.close();
    }
    await expect(queueProgram(s, (q) => q.drop(job.job.seq))).rejects.toThrow();
    expect(Option.getOrThrow(await inspect(s, job.job.seq)).state).toBe(
      "waiting",
    );
    const after = s.db();
    try {
      expect(after.query("SELECT job_seq FROM job_notices").all()).toEqual([]);
      after.exec("DROP TRIGGER reject_notice");
    } finally {
      after.close();
    }
    await queueProgram(s, (q) => q.drop(job.job.seq));
    const committed = s.db();
    try {
      expect(committed.query("SELECT job_seq FROM job_notices").all()).toEqual([
        { job_seq: job.job.seq },
      ]);
    } finally {
      committed.close();
    }
    const worker = s.spawn();
    await worker.wait("ready");
    const delivered = s.db();
    try {
      expect(delivered.query("SELECT job_seq FROM job_notices").all()).toEqual(
        [],
      );
    } finally {
      delivered.close();
    }
    const late = await Worker.subscribeJob(s.location, job.job.seq);
    expect(Option.getOrThrow(await inspect(s, job.job.seq)).state).toBe(
      "failed",
    );
    late.close();
  } finally {
    await s.close();
  }
}, 60_000);

// Why: older claim writes must clear a current marker even if all diagnostic values stay equal.
test("an older claim update invalidates the lifetime-lock marker", async () => {
  const s = await setup();
  try {
    await enqueue(s);
    const worker = s.spawn();
    await worker.wait("run");
    await worker.stop();
    expect(
      await Effect.runPromise(Worker.hasLegacyWorkerClaim(s.location)),
    ).toBe(false);
    const db = s.db();
    try {
      db.exec(
        "UPDATE worker_state SET pid=pid, socket=socket, started_at=started_at",
      );
    } finally {
      db.close();
    }
    expect(
      await Effect.runPromise(Worker.hasLegacyWorkerClaim(s.location)),
    ).toBe(true);
    const contender = s.spawn();
    expect((await contender.wait("exit")).event).toBe("exit");
  } finally {
    await s.close();
  }
}, 60_000);

// Why: a base-build upsert must invalidate a prior current-worker marker through migration 19's trigger.
test("an older worker claim upsert clears a previous lifetime-lock marker", async () => {
  const s = await setup();
  try {
    await enqueue(s);
    const db = s.db();
    try {
      db.run(
        "INSERT INTO worker_state(id, pid, socket, started_at, last_progress_at, last_progress) VALUES (1, ?, ?, ?, ?, 'claimed')",
        [
          process.pid,
          await Effect.runPromise(Worker.socketPathFor(s.location)),
          "2000-01-01T00:00:00.000Z",
          "2000-01-01T00:00:00.000Z",
        ],
      );
      db.exec("INSERT INTO worker_lock_claim(id) VALUES (1)");
    } finally {
      db.close();
    }
    expect(
      await Effect.runPromise(Worker.hasLegacyWorkerClaim(s.location)),
    ).toBe(false);
    const older = s.spawn({}, s.repository, {}, "older-worker-process.ts");
    await older.wait("run");
    expect(
      await Effect.runPromise(Worker.hasLegacyWorkerClaim(s.location)),
    ).toBe(true);
    const after = s.db();
    try {
      expect(after.query("SELECT id FROM worker_lock_claim").all()).toEqual([]);
      expect(
        after.query("SELECT pid FROM worker_state WHERE id=1").get(),
      ).toEqual({ pid: older.child.pid });
    } finally {
      after.close();
    }
    expect((await cli(s, "recover")).stdout).toContain("Records is still open");
  } finally {
    await s.close();
  }
}, 60_000);

for (const limit of ["stalls", "attempts"] as const) {
  // Why: startup recovery must retain and drain final failures at either recovery limit.
  test(`startup publishes a stalled job failing its ${limit} limit`, async () => {
    const s = await setup();
    try {
      const job = await enqueue(s);
      await queueProgram(s, (q) => q.take(["review.run@2"]));
      const db = s.db();
      try {
        db.run(`UPDATE jobs SET ${limit}=? WHERE job_seq=?`, [
          limit === "stalls"
            ? JOB_POLICIES["review.run@2"].stallLimit
            : JOB_POLICIES["review.run@2"].maxAttempts,
          job.job.seq,
        ]);
      } finally {
        db.close();
      }
      const worker = s.spawn();
      await worker.wait("ready");
      const late = await Worker.subscribeJob(s.location, job.job.seq);
      expect(Option.getOrThrow(await inspect(s, job.job.seq))).toMatchObject({
        state: "failed",
        lastError: { tag: limit === "stalls" ? "StallLimit" : "Stalled" },
      });
      late.close();
      const delivered = s.db();
      try {
        expect(
          delivered.query("SELECT job_seq FROM job_notices").all(),
        ).toEqual([]);
      } finally {
        delivered.close();
      }
    } finally {
      await s.close();
    }
  }, 60_000);
}

// Why: worker stop must wait for connection closure, without repeated reachability probes.
test("worker stop waits on its command connection and returns the active job to waiting", async () => {
  const s = await setup();
  try {
    const job = await enqueue(s);
    const worker = s.spawn();
    await worker.wait("run");
    const result = await cli(s, "stop");
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("Worker stopped.");
    expect(await worker.child.exited).toBe(0);
    expect(Option.getOrThrow(await inspect(s, job.job.seq))).toMatchObject({
      state: "waiting",
      attempts: 0,
    });
  } finally {
    await s.close();
  }
}, 60_000);

// Why: a worker of the build before the socket moved listens inside the store. This build's CLI
// must find it there and stop it there, and this build's worker must stay off the store until then.
test("this build finds and stops an older build's worker on the legacy socket", async () => {
  const s = await setup();
  try {
    const job = await enqueue(s);
    const older = s.spawn(
      {},
      s.repository,
      {},
      "previous-build-worker-process.ts",
    );
    await older.wait("ready");
    const legacy = join(s.location.directory, "worker.sock");
    const status = await cli(s, "status");
    expect(status.code, status.stderr).toBe(0);
    expect(status.stdout).toContain(
      `Worker pid ${older.child.pid} holds ${legacy}.`,
    );
    const contender = s.spawn();
    expect(
      (await Promise.race([contender.wait("exit"), contender.wait("run")]))
        .event,
    ).toBe("exit");
    expect(Option.getOrThrow(await inspect(s, job.job.seq)).state).toBe(
      "waiting",
    );
    const stopped = await cli(s, "stop");
    expect(stopped.code, stopped.stderr).toBe(0);
    expect(stopped.stdout).toContain("Worker stopped.");
    expect(await older.child.exited).toBe(0);
    expect(existsSync(legacy)).toBe(false);
    const next = s.spawn();
    await next.wait("run");
    expect(
      existsSync(await Effect.runPromise(Worker.socketPathFor(s.location))),
    ).toBe(true);
    expect(existsSync(legacy)).toBe(false);
  } finally {
    await s.close();
  }
}, 60_000);

// Why: migrating to the current schema must preserve an older claim written before the lifetime-lock marker existed.
test("a schema 18 older worker stays held while the current build migrates its store and recovers safely", async () => {
  const s = await setup(false);
  try {
    const first = s.spawn(
      { schema18: true },
      s.repository,
      {},
      "older-worker-process.ts",
    );
    await first.wait("run");
    const before = s.db();
    try {
      expect(
        before
          .query("SELECT max(migration_id) AS version FROM records_migrations")
          .get(),
      ).toEqual({ version: 18 });
      expect(before.query("PRAGMA journal_mode").get()).toEqual({
        journal_mode: "wal",
      });
      expect(
        before
          .query("SELECT 1 FROM sqlite_master WHERE name='worker_lock_claim'")
          .get(),
      ).toBeNull();
    } finally {
      before.close();
    }
    const liveRecovery = await cli(s, "recover");
    expect(liveRecovery.code).toBe(1);
    expect(liveRecovery.stdout).toContain("Records is still open");
    // Status opens Records through the real CLI migration path while the older connection lives.
    const status = await cli(s, "status");
    expect(status.code, status.stderr).toBe(1);
    expect(status.stdout).toContain("held by an older worker");
    expect(first.child.exitCode).toBeNull();
    const migrated = s.db();
    try {
      // Every migration from the marker's (19) to the current schema ran under the live claim.
      expect(
        migrated
          .query(
            "SELECT migration_id AS id FROM records_migrations WHERE migration_id > 18 ORDER BY migration_id",
          )
          .all(),
      ).toEqual(
        Array.from({ length: SCHEMA_VERSION - 18 }, (_, index) => ({
          id: 19 + index,
        })),
      );
      expect(
        migrated
          .query("SELECT max(migration_id) AS version FROM records_migrations")
          .get(),
      ).toEqual({ version: SCHEMA_VERSION });
      expect(migrated.query("SELECT id FROM worker_lock_claim").all()).toEqual(
        [],
      );
      expect(
        migrated.query("SELECT pid FROM worker_state WHERE id=1").get(),
      ).toEqual({ pid: first.child.pid });
    } finally {
      migrated.close();
    }
    expect(
      await Effect.runPromise(Worker.hasLegacyWorkerClaim(s.location)),
    ).toBe(true);
    expect((await cli(s, "recover")).stdout).toContain("Records is still open");
    const liveContender = s.spawn();
    expect((await liveContender.wait("exit")).event).toBe("exit");
    expect(Option.getOrThrow(await inspect(s, 1))).toMatchObject({
      state: "active",
      attempts: 1,
      stalls: 0,
    });
    await first.stop();
    // Until explicit recovery, the dead older worker's claim still holds a current worker off its job.
    const deadContender = s.spawn();
    expect(
      (
        await Promise.race([
          deadContender.wait("exit"),
          deadContender.wait("run"),
        ])
      ).event,
    ).toBe("exit");
    expect(Option.getOrThrow(await inspect(s, 1))).toMatchObject({
      state: "active",
      attempts: 1,
      stalls: 0,
    });
    expect((await cli(s, "start")).stderr).toContain("held by an older worker");
    expect((await cli(s, "recover")).code).toBe(0);
    const next = s.spawn();
    await next.wait("run");
    expect(Option.getOrThrow(await inspect(s, 1))).toMatchObject({
      state: "active",
      attempts: 2,
      stalls: 1,
    });
    expect(
      await Effect.runPromise(Worker.hasLegacyWorkerClaim(s.location)),
    ).toBe(false);
  } finally {
    await s.close();
  }
}, 60_000);

const within = async <A>(promise: Promise<A>) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<"no notification">((resolve) => {
        timer = setTimeout(() => resolve("no notification"), 4000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

for (const mode of ["older-sql", "commit-kill"] as const) {
  // Why: a committed terminal outcome must wake an existing follower even when its writer sends no poke.
  test.skipIf(process.env.NEUVE_TEST_NO_FS_EVENTS === "1")(
    `${mode} wakes a connected job follower without another connection`,
    async () => {
      const s = await setup();
      let subscription:
        Awaited<ReturnType<typeof Worker.subscribeJob>> | undefined;
      try {
        const active = await enqueue(s);
        const worker = s.spawn();
        await worker.wait("run");
        const waiting = await enqueue(s, mode);
        subscription = await Worker.subscribeJob(s.location, waiting.job.seq);
        await worker.wait("subscribed");
        const writer = s.spawn(
          { mode, seq: waiting.job.seq },
          s.repository,
          {},
          "shared-notice-writer.ts",
        );
        await writer.wait("committed");
        if (mode === "commit-kill") writer.child.kill("SIGKILL");
        await writer.child.exited;
        const committed = s.db();
        try {
          expect(
            committed
              .query("SELECT state FROM jobs WHERE job_seq = ?")
              .get(waiting.job.seq),
          ).toEqual({ state: "failed" });
        } finally {
          committed.close();
        }
        expect(await within(subscription.next())).toBe("changed");
        await worker.wait("delivered");
        expect(
          Option.getOrThrow(await inspect(s, waiting.job.seq)),
        ).toMatchObject({ state: "failed" });
        expect(
          Option.getOrThrow(await inspect(s, active.job.seq)),
        ).toMatchObject({ state: "active", attempts: 1 });
        const database = s.db();
        expect(database.query("SELECT * FROM job_notices").all()).toEqual([]);
        database.close();
        // These timers bound a quiet observation, never readiness or database polling.
        await new Promise((resolve) => setTimeout(resolve, 700));
        const drains = worker.events.filter(
          (event) => event.event === "drained",
        ).length;
        expect(drains).toBeGreaterThan(0);
        await new Promise((resolve) => setTimeout(resolve, 700));
        expect(
          worker.events.filter((event) => event.event === "drained").length,
        ).toBe(drains);
      } finally {
        subscription?.close();
        await s.close();
      }
    },
    60_000,
  );
}

// Why: cancelling the last subscriber must stop inference, settle cleanup and produce no unhandled rejection.
for (const mode of ["cancel", "failure", "defect"] as const) {
  // Why: every batch exit must settle its resources and produce no unhandled rejection.
  test(`benchmark ${mode === "cancel" ? "last subscriber cancellation" : mode} settles batch cleanup`, async () => {
    const { hostBudget } = await import("../src/budget/local.ts");
    const s = await setup();
    const host = await hostBudget({
      directory: s.directory,
      threads: 2,
      fixed: 4,
    });
    await host?.claims.ready;
    try {
      const chunk = await Effect.runPromise(
        Blobs.BlobStore.use((blobs) =>
          blobs.put({
            bytes: new TextEncoder().encode("one"),
            mediaType: "text/plain",
            retention: "durable",
          }),
        ).pipe(
          Effect.provide(Blobs.layer(s.location)),
          Effect.provide(Store.layer(s.location, { create: false })),
          Effect.provide(BunFileSystem.layer),
        ),
      );
      const child = s.spawn(
        { chunks: [chunk.blob.hash], mode },
        s.repository,
        {},
        "shared-dense-cancel.ts",
      );
      await child.wait("encode");
      if (mode === "cancel") {
        child.send("cancel");
        await child.wait("encoder-stopped");
      }
      await child.wait(mode);
      expect(await within(child.wait("settled"))).toEqual({ event: "settled" });
      expect(await child.child.exited).toBe(0);
      expect(
        child.events.filter((event) => event.event === "unhandled"),
      ).toEqual([]);
    } finally {
      await s.close();
      await host?.close();
    }
  }, 60_000);
}

// Why: an empty outbox must cause no database write and no further drain without another event.
test("an empty notice drain is read-only and stays quiet", async () => {
  const s = await setup();
  try {
    await enqueue(s);
    const worker = s.spawn();
    await worker.wait("run");
    const db = s.db();
    try {
      const before = db.query("PRAGMA data_version").get();
      const after = worker.events.length;
      const path = await Effect.runPromise(Worker.socketPathFor(s.location));
      await Effect.runPromise(Worker.reachWorker(path, "status"));
      await worker.wait("drained", after);
      expect(db.query("PRAGMA data_version").get()).toEqual(before);
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const drains = worker.events.filter(
        (event) => event.event === "drained",
      ).length;
      await new Promise((resolve) => setTimeout(resolve, 700));
      expect(
        worker.events.filter((event) => event.event === "drained").length,
      ).toBe(drains);
      expect(db.query("PRAGMA data_version").get()).toEqual(before);
    } finally {
      db.close();
    }
  } finally {
    await s.close();
  }
}, 60_000);
