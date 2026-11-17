import { captureOutlineSource } from "../src/graph-outline.ts";
import { References } from "effect";
import { expect, test } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  existsSync,
  writeFileSync,
  mkdirSync,
  renameSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Database } from "bun:sqlite";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { Effect, Layer, Logger } from "effect";
import {
  Store,
  resolveStoreLocation,
  Blobs,
  Computations,
  Worker,
  JobQueue,
} from "@neuve/records-core";
import { hostBudget } from "../src/budget/local.ts";
import { z } from "zod";
import { createConnection, createServer } from "node:net";
import { sharedWorkOwnership } from "@neuve/records-core/shared-work-socket";

const Event = z.object({
  event: z.string(),
  role: z.string().optional(),
  floor: z.string().optional(),
  value: z.string().optional(),
  status: z.string().optional(),
  _tag: z.string().optional(),
  tag: z.string().optional(),
  message: z.string().optional(),
  attemptId: z.string().optional(),
  count: z.number().optional(),
  vectors: z.array(z.string()).optional(),
});
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
async function setup(hosted = true, ready = true) {
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
  const alias = join(root, "alias");
  git("-C", repository, "worktree", "add", "--detach", "-q", alias);
  const location = await Effect.runPromise(resolveStoreLocation(repository));
  await Effect.runPromise(
    Store.prepareForWrite.pipe(
      Effect.provide(Store.layer(location, { create: true })),
      Effect.provide(BunFileSystem.layer),
    ),
  );
  let host = hosted
    ? await hostBudget({ directory, threads: 2, fixed: 4 })
    : undefined;
  if (hosted && !host) throw new Error("host missing");
  if (host && !ready) {
    await host.close();
    host = await hostBudget({ directory, threads: 2, fixed: 4 });
    if (!host) throw new Error("replacement host missing");
  }
  if (ready) await host?.claims.ready;
  const executions = join(root, "executions");
  const children: Array<{ stop: () => Promise<void> }> = [];
  function spawn(
    options: object = {},
    path = repository,
    env: Record<string, string> = {},
    fixture = "shared-computation-process.ts",
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
            executions,
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
    const wait = (event: string, role?: string) =>
      new Promise<Event>((resolve, reject) => {
        const inspect = () => {
          const found = events.find(
            (item) =>
              item.event === event &&
              (role === undefined || item.role === role),
          );
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
  const attempts = () => {
    const sql = db();
    try {
      return sql
        .query(
          "SELECT outcome, error_tag AS tag FROM computation_attempts ORDER BY n",
        )
        .all();
    } finally {
      sql.close();
    }
  };
  return {
    root,
    directory,
    repository,
    alias,
    location,
    host,
    spawn,
    db,
    attempts,
    executions,
    count: () =>
      existsSync(executions)
        ? readFileSync(executions, "utf8").trim().split("\n").length
        : 0,
    close: async () => {
      await Promise.all(children.map((c) => c.stop()));
      await host?.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

// Why: checkout aliases must meet at the canonical Records store before executing.
test("two processes through two checkouts compute one key once", async () => {
  const s = await setup();
  try {
    const holder = s.spawn();
    await holder.wait("run");
    const waiter = s.spawn({}, s.alias);
    await waiter.wait("role", "waiter");
    expect(s.count()).toBe(1);
    holder.send("run");
    expect((await holder.wait("result")).value).toBe("stored fixture value");
    expect((await waiter.wait("result")).value).toBe("stored fixture value");
    await Promise.all([holder.child.exited, waiter.child.exited]);
    expect(s.count()).toBe(1);
    expect(s.attempts()).toEqual([{ outcome: "succeeded", tag: null }]);
  } finally {
    await s.close();
  }
}, 60_000);

// Why: subscribers receive the failed attempt's immutable cause without running a retry.
test("another process receives the recorded attempt failure", async () => {
  const s = await setup();
  try {
    const holder = s.spawn({ failed: true });
    await holder.wait("run");
    const waiter = s.spawn();
    await waiter.wait("role", "waiter");
    holder.send("run");
    const failure = await waiter.wait("failed");
    expect(failure._tag).toBe("SharedAttemptFailed");
    expect(failure.tag).toBe("FixtureFailed");
    expect(failure.message).toBe("recorded fixture cause");
    expect(failure.attemptId).toBeString();
    expect(s.count()).toBe(1);
  } finally {
    await s.close();
  }
}, 60_000);

// Why: ownership ends on connection death and the takeover abandons only that dead attempt.
test("SIGKILL holder lets its waiter abandon and recompute", async () => {
  const s = await setup();
  try {
    const holder = s.spawn();
    await holder.wait("run");
    const waiter = s.spawn();
    await waiter.wait("role", "waiter");
    await holder.stop();
    await waiter.wait("run");
    expect(s.attempts()).toEqual([
      { outcome: "abandoned", tag: "Abandoned" },
      { outcome: "running", tag: null },
    ]);
    waiter.send("run");
    expect((await waiter.wait("result")).value).toBe("stored fixture value");
    expect(s.count()).toBe(2);
  } finally {
    await s.close();
  }
}, 60_000);

// Why: a child holding CPU admission must skip an occupied computation rather than wait.
test("inside-grant caller gets KeyHeld before computing", async () => {
  const s = await setup();
  try {
    const holder = s.spawn();
    await holder.wait("run");
    const child = s.spawn({ inside: true });
    expect((await child.wait("failed"))._tag).toBe("KeyHeld");
    expect(s.count()).toBe(1);
    holder.send("run");
    await holder.wait("result");
  } finally {
    await s.close();
  }
}, 60_000);

// Why: terminal notification must follow commit, and a failed commit must transfer ownership.
for (const rejected of [false, true])
  for (const failed of [false, true])
    test(`publication ordering with rejected commit=${rejected}, failure=${failed}`, async () => {
      const s = await setup();
      try {
        const holder = s.spawn({
          breakCommit: rejected,
          beforeCommit: true,
          failed,
        });
        await holder.wait("run");
        const waiter = s.spawn();
        await waiter.wait("role", "waiter");
        holder.send("run");
        await holder.wait("commit-boundary");
        const key = Computations.computationKey({
          op: "test.shared-p5",
          opVersion: 1,
          inputs: { value: "one" },
        }).key;
        expect(
          await sharedWorkOwnership(
            dirname(s.location.directory),
            key,
            s.directory,
          ),
        ).toBe("live");
        expect(s.attempts()).toEqual([{ outcome: "running", tag: null }]);
        expect(
          waiter.events.some((e) =>
            ["result", "failed", "run"].includes(e.event),
          ),
        ).toBe(false);
        holder.send("commit");
        if (rejected) {
          await holder.wait("failed");
          await waiter.wait("role", "takeover");
          await waiter.wait("run");
          expect(s.attempts()).toEqual([
            { outcome: "abandoned", tag: "Abandoned" },
            { outcome: "running", tag: null },
          ]);
          waiter.send("run");
        }
        if (failed && !rejected)
          expect((await waiter.wait("failed")).tag).toBe("FixtureFailed");
        else
          expect((await waiter.wait("result")).value).toBe(
            "stored fixture value",
          );
        expect(s.count()).toBe(rejected ? 2 : 1);
      } finally {
        await s.close();
      }
    }, 60_000);

// Why: startup recovery must preserve a live harness claim while abandoning a dead process's row.
test("recovery skips live claims and abandons ended ownership", async () => {
  const s = await setup();
  try {
    const holder = s.spawn();
    await holder.wait("run");
    const live = s.spawn({ mode: "recover" });
    expect((await live.wait("recovered")).count).toBe(0);
    await live.child.exited;
    expect(s.attempts()).toEqual([{ outcome: "running", tag: null }]);
    await holder.stop();
    const dead = s.spawn({ mode: "recover" });
    expect((await dead.wait("recovered")).count).toBe(1);
    await dead.child.exited;
    expect(s.attempts()).toEqual([{ outcome: "abandoned", tag: "Abandoned" }]);
  } finally {
    await s.close();
  }
}, 60_000);

// Why: without a host, execution remains available and explicitly discloses possible duplication.
test("floor computes alone and recovery leaves unknown ownership untouched", async () => {
  const s = await setup(false);
  try {
    const holder = s.spawn();
    await holder.wait("role", "floor");
    await holder.wait("run");
    const sweep = s.spawn({ mode: "recover" });
    expect((await sweep.wait("recovered")).count).toBe(0);
    holder.send("run");
    expect((await holder.wait("result")).value).toBe("stored fixture value");
    expect(s.count()).toBe(1);
  } finally {
    await s.close();
  }
}, 60_000);

// Why: recovery observations must be delayed until surviving holders have re-declared.
test("startup sweep waits for the new host's re-declaration window", async () => {
  const s = await setup(true, false);
  try {
    const db = s.db();
    db.run(
      "INSERT INTO computation_attempts(attempt_id,key,n,op,started_at,outcome) VALUES('dead-attempt','dead-key',1,'test.shared-p5',datetime('now'),'running')",
    );
    db.close();
    const sweep = s.spawn({ mode: "recover" });
    await sweep.wait("recovering");
    expect(sweep.events.some((event) => event.event === "recovered")).toBe(
      false,
    );
    await s.host?.claims.ready;
    expect((await sweep.wait("recovered")).count).toBe(1);
  } finally {
    await s.close();
  }
}, 60_000);

// Why: an artifact in a user directory must share execution and publish the clone atomically.
for (const failed of [false, true])
  test(`Graph clone is shared across processes, failure=${failed}`, async () => {
    const s = await setup();
    try {
      const bin = join(s.root, "bin");
      mkdirSync(bin);
      const { createServer } = await import("node:net");
      const { chmodSync } = await import("node:fs");
      const started = Promise.withResolvers<import("node:net").Socket>();
      const controlPath = join(s.root, "clone.sock");
      const control = createServer((socket) => started.resolve(socket));
      await new Promise<void>((resolve, reject) => {
        control.once("error", reject);
        control.listen(controlPath, resolve);
      });
      writeFileSync(
        join(bin, "git"),
        `#!${process.execPath}\nimport {appendFileSync} from "node:fs";import {createConnection} from "node:net";\nif(process.argv.includes("clone")){appendFileSync(${JSON.stringify(s.executions)},"clone\\n");const socket=createConnection(${JSON.stringify(controlPath)});await new Promise((resolve,reject)=>{socket.on("data",resolve);socket.on("error",reject);});socket.destroy();if(process.env.NEUVE_FAIL_CLONE==="1"){process.stderr.write("fixture clone cause\\n");process.exit(1);}}\nconst child=Bun.spawn(["/usr/bin/git",...process.argv.slice(2)],{stdin:"inherit",stdout:"inherit",stderr:"inherit"});process.exit(await child.exited);\n`,
      );
      chmodSync(join(bin, "git"), 0o700);
      const env = { PATH: `${bin}:${process.env.PATH ?? ""}` };
      const work = join(s.root, "graph");
      const holder = s.spawn(
        { mode: "clone", work, keyedPool: true },
        s.repository,
        {
          ...env,
          NEUVE_FAIL_CLONE: failed ? "1" : "0",
        },
      );
      const socket = await started.promise;
      const waiter = s.spawn(
        { mode: "clone", work, keyedPool: true },
        s.alias,
        env,
      );
      await waiter.wait("role", "waiter");
      expect((await s.host!.scheduler.observe()).held).toBe(1);
      const preparation = s.spawn(
        { mode: "clone", work, inside: true, prepareClone: true },
        s.alias,
        env,
      );
      expect((await preparation.wait("failed"))._tag).toBe("KeyHeld");
      socket.end("run");
      if (failed) {
        const failure = await waiter.wait("failed");
        expect(failure._tag).toBe("GraphUnavailable");
        expect(failure.message).toContain("fixture clone cause");
      } else {
        const result = await waiter.wait("result");
        expect(existsSync(join(result.value ?? "", ".git"))).toBe(true);
        expect((await holder.wait("result")).value).toBe(result.value);
      }
      expect(s.count()).toBe(1);
      await new Promise<void>((resolve) => control.close(() => resolve()));
    } finally {
      await s.close();
    }
  }, 60_000);

// Why: batch inference must begin inside each held key so another process never encodes its chunks.
test("two benchmark processes encode each chunk once while retaining batches", async () => {
  const s = await setup();
  try {
    const chunks = await Effect.runPromise(
      Blobs.BlobStore.use((blobs) =>
        Effect.forEach(["one", "two", "three"], (text) =>
          Effect.map(
            blobs.put({
              bytes: new TextEncoder().encode(text),
              mediaType: "text/plain",
              retention: "durable",
            }),
            (row) => row.blob.hash,
          ),
        ),
      ).pipe(
        Effect.provide(Blobs.layer(s.location)),
        Effect.provide(Store.layer(s.location, { create: false })),
        Effect.provide(BunFileSystem.layer),
      ),
    );
    const env = {
      NEUVE_DENSE_TEST: JSON.stringify({
        repository: s.repository,
        executions: s.executions,
        chunks,
      }),
    };
    const holder = s.spawn({}, s.repository, env, "shared-dense-process.ts");
    await holder.wait("encode");
    const waiter = s.spawn(
      {},
      s.alias,
      {
        ...env,
        NEUVE_DENSE_TEST: JSON.stringify({
          repository: s.alias,
          executions: s.executions,
          chunks,
        }),
      },
      "shared-dense-process.ts",
    );
    await waiter.wait("role", "waiter");
    holder.send("run");
    waiter.send("run");
    const results = await Promise.all([
      holder.wait("result"),
      waiter.wait("result"),
    ]);
    const { MODELS } =
      await import("../../evaluation/src/retrieval-bench/models.ts");
    const expected = ["one", "two", "three"].map((value, index) => {
      const text = MODELS.E0.format.document(`${index}.ts`, value);
      const vector = Float32Array.from(
        { length: MODELS.E0.dimensions },
        (_, i) => ((text.charCodeAt(i % text.length) + i) % 127) / 8,
      );
      return Buffer.from(vector.buffer).toString("hex");
    });
    for (const result of results) expect(result.vectors).toEqual(expected);
    const batches = readFileSync(s.executions, "utf8")
      .trim()
      .split("\n")
      .map((line) => z.array(z.string()).parse(JSON.parse(line)));
    expect(batches.flat()).toHaveLength(3);
    expect(new Set(batches.flat()).size).toBe(3);
    expect(batches.some((batch) => batch.length > 1)).toBe(true);
  } finally {
    await s.close();
  }
}, 60_000);

const enqueue = async (s: Awaited<ReturnType<typeof setup>>) =>
  Effect.runPromise(
    JobQueue.JobQueue.use((queue) =>
      queue.enqueue({ kind: "review.run@2", dedupeKey: "review.run:p5:0" }),
    ).pipe(
      Effect.provide(JobQueue.layer),
      Effect.provide(Store.layer(s.location, { create: false })),
      Effect.provide(BunFileSystem.layer),
    ),
  );
const inspectJob = async (s: Awaited<ReturnType<typeof setup>>, seq: number) =>
  Effect.runPromise(
    JobQueue.JobQueue.use((queue) => queue.inspect(seq)).pipe(
      Effect.provide(JobQueue.layer),
      Effect.provide(Store.layer(s.location, { create: false })),
      Effect.provide(BunFileSystem.layer),
    ),
  );

// Why: a waiting follower subscribes without taking the queue job, then reads a committed outcome.
for (const failed of [false, true])
  test(`job followers receive a committed terminal push, failure=${failed}`, async () => {
    const s = await setup();
    try {
      const job = await enqueue(s);
      const worker = s.spawn(
        { failed },
        s.repository,
        {},
        "shared-job-process.ts",
      );
      await worker.wait("ready");
      await worker.wait("run");
      const subscription = await Worker.subscribeJob(s.location, job.job.seq);
      try {
        worker.send("run");
        expect(await subscription.next()).toBe("changed");
        const job = await inspectJob(s, 1);
        expect(job._tag).toBe("Some");
        if (job._tag === "Some") {
          expect(job.value.state).toBe(failed ? "failed" : "completed");
          if (failed)
            expect(job.value.lastError?.message).toBe("job fixture cause");
        }
      } finally {
        subscription.close();
      }
    } finally {
      await s.close();
    }
  }, 60_000);

// Why: a worker built before lifetime locks must retain ownership while its listener accepts.
test("a reachable old worker without a lifetime lock refuses takeover", async () => {
  const s = await setup(false);
  try {
    const job = await enqueue(s);
    const old = s.spawn(
      {},
      s.repository,
      {},
      "shared-legacy-worker-process.ts",
    );
    await old.wait("ready");
    const path = join(s.location.directory, "worker.sock");
    expect(existsSync(`${path}.sqlite`)).toBe(false);
    const contender = s.spawn({}, s.repository, {}, "shared-job-process.ts");
    expect(
      (await Promise.race([contender.wait("exit"), contender.wait("run")]))
        .event,
    ).toBe("exit");
    const stored = await inspectJob(s, job.job.seq);
    if (stored._tag === "Some") expect(stored.value.state).toBe("waiting");
    else throw new Error("missing job");
    expect(await Effect.runPromise(Worker.reachWorker(path, "status"))).toEqual(
      { _tag: "Answered", reply: "legacy" },
    );
  } finally {
    await s.close();
  }
}, 60_000);

// Why: macOS refuses connections to a full live backlog; only kernel lock release permits takeover.
test.skipIf(process.platform !== "darwin")(
  "a stopped worker with a refused full backlog retains its active job",
  async () => {
    const s = await setup(false);
    const sockets: ReturnType<typeof createConnection>[] = [];
    const job = await enqueue(s);
    const first = s.spawn({}, s.repository, {}, "shared-job-process.ts");
    let subscription:
      Awaited<ReturnType<typeof Worker.subscribeJob>> | undefined;
    try {
      await first.wait("run");
      subscription = await Worker.subscribeJob(s.location, job.job.seq);
      first.child.kill("SIGSTOP");
      const path = await Effect.runPromise(Worker.socketPathFor(s.location));
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
              }, 2_000);
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
      const contender = s.spawn({}, s.repository, {}, "shared-job-process.ts");
      expect(
        (await Promise.race([contender.wait("exit"), contender.wait("run")]))
          .event,
      ).toBe("exit");
      expect(contender.events.some((e) => e.event === "run")).toBe(false);
      const stored = await inspectJob(s, job.job.seq);
      expect(stored._tag).toBe("Some");
      if (stored._tag === "Some") {
        expect(stored.value.state).toBe("active");
        expect(stored.value.stalls).toBe(0);
      }
      first.child.kill("SIGCONT");
      for (const socket of sockets) socket.destroy();
      first.send("run");
      expect(await subscription.next()).toBe("changed");
      subscription.close();
    } finally {
      first.child.kill("SIGCONT");
      subscription?.close();
      for (const socket of sockets) socket.destroy();
      await s.close();
    }
  },
  60_000,
);

// Why: a dead worker releases its kernel lock immediately, independently of its recorded PID.
test("SIGKILL worker closes its follower and a new worker recovers the job", async () => {
  const s = await setup();
  try {
    const job = await enqueue(s);
    const first = s.spawn({}, s.repository, {}, "shared-job-process.ts");
    await first.wait("run");
    const subscription = await Worker.subscribeJob(s.location, job.job.seq);
    const loss = subscription.next().catch((error: unknown) => error);
    await first.stop();
    expect(await loss).toBeInstanceOf(Worker.WorkerSubscriptionLost);
    subscription.close();
    const next = s.spawn({}, s.repository, {}, "shared-job-process.ts");
    await next.wait("run");
    const replacement = await Worker.subscribeJob(s.location, job.job.seq);
    next.send("run");
    expect(await replacement.next()).toBe("changed");
    replacement.close();
    const stored = await inspectJob(s, job.job.seq);
    if (stored._tag === "Some") {
      expect(stored.value.state).toBe("completed");
      expect(stored.value.stalls).toBe(1);
    } else throw new Error("missing job");
    expect(
      await Effect.runPromise(
        Worker.holderGone(s.location, { _tag: "Absent" }),
      ),
    ).toBe(false);
    expect(
      await Effect.runPromise(
        Worker.holderGone(s.location, {
          _tag: "Refused",
          code: "ECONNREFUSED",
        }),
      ),
    ).toBe(false);
    expect(
      await Effect.runPromise(
        Worker.holderGone(s.location, { _tag: "Refused", code: "EPERM" }),
      ),
    ).toBe(false);
    expect(
      await Effect.runPromise(
        Worker.holderGone(s.location, { _tag: "Unanswered" }),
      ),
    ).toBe(false);
    await next.stop();
    expect(
      await Effect.runPromise(
        Worker.holderGone(s.location, {
          _tag: "Refused",
          code: "ECONNREFUSED",
        }),
      ),
    ).toBe(true);
  } finally {
    await s.close();
  }
}, 60_000);

// Why: held reviews are reported by their owning worker's connection without PID liveness checks.
test("a follower learns a held review from the worker socket", async () => {
  const s = await setup();
  try {
    const job = await enqueue(s);
    const worker = s.spawn(
      { held: true },
      s.repository,
      {},
      "shared-job-process.ts",
    );
    await worker.wait("ready");
    const subscription = await Worker.subscribeJob(s.location, job.job.seq);
    try {
      expect(await subscription.next()).toBe("held");
    } finally {
      subscription.close();
    }
  } finally {
    await s.close();
  }
}, 60_000);

// Why: the actual review follower must settle from a subscription registered before completion.
for (const failed of [false, true])
  test(`review CLI follows terminal push, failure=${failed}`, async () => {
    const s = await setup();
    try {
      const job = await enqueue(s);
      const worker = s.spawn(
        { failed },
        s.repository,
        {},
        "shared-job-process.ts",
      );
      await worker.wait("run");
      const { follow } =
        await import("../../../apps/neuve-cli/src/review-cli.ts");
      const followed = follow(
        s.repository,
        s.location,
        job.job.seq,
        "p5-follow",
      );
      await worker.wait("subscribed");
      worker.send("run");
      expect(await followed).toBe(failed ? 1 : 0);
    } finally {
      await s.close();
    }
  }, 60_000);

// Why: a stopped worker retains one pending follower connection past the former handshake deadline.
test("a review follower keeps one subscription while its worker is stopped", async () => {
  const s = await setup(false);
  const peers: ReturnType<typeof createConnection>[] = [];
  const subscribing = Promise.withResolvers<void>();
  let attempts = 0;
  let connections = 0;
  let followed: Promise<number> | undefined;
  const path = await Effect.runPromise(Worker.socketPathFor(s.location));
  const backend = `${path.slice(0, -5)}.r7`;
  const relay = createServer((peer) => {
    connections++;
    const target = createConnection(backend);
    peers.push(peer, target);
    peer.on("error", () => target.destroy());
    target.on("error", () => peer.destroy());
    let buffer = "";
    peer.on("data", (chunk) => {
      buffer += chunk.toString();
      if (buffer.includes("subscribe ")) {
        attempts++;
        buffer = "";
        subscribing.resolve();
      }
    });
    peer.pipe(target).pipe(peer);
    peer.on("close", () => target.destroy());
    target.on("close", () => peer.destroy());
  });
  const job = await enqueue(s);
  const worker = s.spawn({}, s.repository, {}, "shared-job-process.ts");
  try {
    await worker.wait("run");
    worker.child.kill("SIGSTOP");
    renameSync(path, backend);
    await new Promise<void>((resolve, reject) => {
      relay.once("error", reject);
      relay.listen(path, resolve);
    });
    const { follow } =
      await import("../../../apps/neuve-cli/src/review-cli.ts");
    followed = follow(s.repository, s.location, job.job.seq, "p5-stopped");
    // Attach rejection handling immediately, including when an earlier assertion fails.
    void followed.catch(() => {});
    await subscribing.promise;
    const connected = connections;
    // A bounded observation crosses the old 2-second timer; counts prove there is no reconnect.
    await new Promise((resolve) => setTimeout(resolve, 4_500));
    expect(attempts).toBe(1);
    expect(connections).toBe(connected);
    worker.child.kill("SIGCONT");
    await worker.wait("subscribed");
    worker.send("run");
    expect(await followed).toBe(0);
    expect(attempts).toBe(1);
  } finally {
    worker.child.kill("SIGCONT");
    for (const peer of peers) peer.destroy();
    await new Promise<void>((resolve) => relay.close(() => resolve()));
    await s.close();
    await followed?.catch(() => {});
  }
}, 60_000);

// Why: caller cancellation during handshake or after registration must preserve its reason.
for (const registered of [false, true])
  test(`subscription abort is caller cancellation, registered=${registered}`, async () => {
    const s = await setup(false);
    const controller = new AbortController();
    const reason = new Error("caller gave up");
    const received = Promise.withResolvers<void>();
    const peers: ReturnType<typeof createConnection>[] = [];
    const server = createServer((socket) => {
      peers.push(socket);
      socket.on("data", () => {
        if (registered) socket.write("subscribed\n");
        received.resolve();
      });
    });
    try {
      const path = await Effect.runPromise(Worker.socketPathFor(s.location));
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(path, resolve);
      });
      const pending = Worker.subscribeJob(s.location, 1, controller.signal);
      await received.promise;
      if (registered) {
        const subscription = await pending;
        const next = subscription.next();
        controller.abort(reason);
        await expect(next).rejects.toBe(reason);
        await expect(subscription.next()).rejects.toBe(reason);
      } else {
        controller.abort(reason);
        await expect(pending).rejects.toBe(reason);
      }
    } finally {
      controller.abort(reason);
      for (const peer of peers) peer.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await s.close();
    }
  }, 60_000);

// Why: upkeep expiry is a caller deadline and must settle without reconnecting or starting another worker.
test("worker upkeep settles its own deadline while the worker stays stopped", async () => {
  const s = await setup(false);
  const job = await enqueue(s);
  const worker = s.spawn({}, s.repository, {}, "shared-job-process.ts");
  try {
    await worker.wait("run");
    worker.child.kill("SIGSTOP");
    const { keepWorkerFor } =
      await import("../../../apps/neuve-cli/src/review-worker.ts");
    const kept = await keepWorkerFor({
      project: s.repository,
      job: job.job.seq,
      watchMs: 1_500,
    });
    expect(await kept.settled).toBe("active");
    expect(
      worker.events.filter((event) => event.event === "subscribed"),
    ).toHaveLength(0);
    worker.child.kill("SIGCONT");
    const subscription = await Worker.subscribeJob(s.location, job.job.seq);
    try {
      worker.send("run");
      expect(await subscription.next()).toBe("changed");
    } finally {
      subscription.close();
    }
  } finally {
    worker.child.kill("SIGCONT");
    await s.close();
  }
}, 60_000);

// Why: one subscriber closing its own Records layer must not close resources still serving another.
test("a cancelled local subscriber retains publication resources for its survivor", async () => {
  const s = await setup();
  const previous = process.env.NEUVE_BUDGET_DIRECTORY;
  process.env.NEUVE_BUDGET_DIRECTORY = s.directory;
  try {
    const entered = Promise.withResolvers<void>();
    const joined = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const controller = new AbortController();
    let runs = 0;
    const call = () =>
      Computations.ComputationStore.use((store) =>
        store.run(
          { op: "test.local-cancel", opVersion: 1, inputs: {} },
          Effect.gen(function* () {
            runs++;
            entered.resolve();
            yield* Effect.promise(() => finish.promise);
            return {
              bytes: new TextEncoder().encode("survived"),
              mediaType: "text/plain",
            };
          }),
        ),
      ).pipe(
        Effect.provide(
          Computations.layer.pipe(Layer.provideMerge(Blobs.layer(s.location))),
        ),
        Effect.provide(Store.layer(s.location, { create: false })),
        Effect.provide(BunFileSystem.layer),
      );
    const first = Effect.runPromise(call(), {
      signal: controller.signal,
    }).catch(() => undefined);
    await entered.promise;
    const second = Effect.runPromise(
      call().pipe(
        Effect.provideService(References.MinimumLogLevel, "Debug"),
        Effect.provide(
          Logger.layer([
            Logger.make(({ message }) => {
              if (
                [message]
                  .flat()
                  .some(
                    (item) =>
                      typeof item === "object" &&
                      item !== null &&
                      "role" in item &&
                      item.role === "waiter",
                  )
              )
                joined.resolve();
            }),
          ]),
        ),
      ),
    );
    await joined.promise;
    controller.abort();
    finish.resolve();
    expect(new TextDecoder().decode((await second).output)).toBe("survived");
    await first;
    expect(runs).toBe(1);
  } finally {
    if (previous === undefined) delete process.env.NEUVE_BUDGET_DIRECTORY;
    else process.env.NEUVE_BUDGET_DIRECTORY = previous;
    await s.close();
  }
}, 60_000);

// Why: the real worker's startup sweep must leave a live harness attempt alone and recover a dead one.
test("worker startup preserves a live computation and abandons ended ownership", async () => {
  const s = await setup();
  try {
    const holder = s.spawn();
    await holder.wait("run");
    const worker = s.spawn({}, s.repository, {}, "shared-job-process.ts");
    await worker.wait("ready");
    expect(s.attempts()).toEqual([{ outcome: "running", tag: null }]);
    await worker.stop();
    await holder.stop();
    const replacement = s.spawn({}, s.repository, {}, "shared-job-process.ts");
    await replacement.wait("ready");
    expect(s.attempts()).toEqual([{ outcome: "abandoned", tag: "Abandoned" }]);
  } finally {
    await s.close();
  }
}, 60_000);

// Why: the real preparation function must skip a held hunk computation and finish its child.
test("preparation child skips hunks held by a review", async () => {
  const s = await setup();
  try {
    const { commitHunksSpec } = await import("../src/commit-prepare.ts");
    const { emptyTree } = await import("../src/git-objects.ts");
    const tree = git("-C", s.repository, "rev-parse", "HEAD^{tree}");
    const oid = git("-C", s.repository, "rev-parse", "HEAD");
    const from = await Effect.runPromise(emptyTree(s.repository));
    const spec = commitHunksSpec(from, tree, captureOutlineSource());
    const holder = s.spawn({ spec });
    await holder.wait("run");
    const preparation = s.spawn({
      mode: "prepare",
      inside: true,
      commit: { oid, tree, parents: [] },
    });
    expect((await preparation.wait("skipped")).count).toBe(0);
    expect(s.count()).toBe(1);
    await holder.stop();
  } finally {
    await s.close();
  }
}, 60_000);

// Why: each real foreground path must subscribe to another process before taking CPU permits.
for (const [operation, holdOp] of [
  ["chunks", "harness.blob-chunks"],
  ["index", "harness.blob-chunks"],
  ["lookup", "harness.blob-chunks"],
  ["hunks", "harness.blob-chunks"],
  ["leads", "harness.hunk-leads"],
  ["e0", "harness.e0-query"],
] as const)
  test(`foreground ${operation} subscribes without a grant to a remote ${holdOp}`, async () => {
    const s = await setup();
    try {
      writeFileSync(join(s.repository, "readme.md"), "fixture changed\n");
      git("-C", s.repository, "add", ".");
      git(
        "-C",
        s.repository,
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@example.test",
        "commit",
        "-qm",
        "changed",
      );
      const fixture = "shared-grant-process.ts";
      const holder = s.spawn(
        {
          operation:
            operation === "leads"
              ? "direct-leads"
              : operation === "e0"
                ? "e0"
                : "chunks",
          holdOp,
        },
        s.repository,
        {},
        fixture,
      );
      await holder.wait("run");
      const waiter = s.spawn({ operation }, s.repository, {}, fixture);
      await waiter.wait("role", "waiter");
      expect((await s.host!.scheduler.observe()).held).toBe(0);
      expect(
        waiter.events.some(
          (event) => event.event === "failed" || event.event === "result",
        ),
      ).toBe(false);
      holder.send("run");
      if (operation === "e0") {
        const failed = await waiter.wait("failed");
        expect(failed._tag).toBe("SharedAttemptFailed");
        expect(failed.message).toContain("fixture E0 refusal");
      } else expect((await waiter.wait("result")).count).toBeGreaterThan(0);
      await Promise.all([holder.child.exited, waiter.child.exited]);
      const keys = readFileSync(s.executions, "utf8").trim().split("\n");
      expect(keys.length).toBe(1);
      expect(new Set(keys).size).toBe(keys.length);
      expect((await s.host!.scheduler.observe()).held).toBe(0);
    } finally {
      await s.close();
    }
  }, 60_000);

// Why: preparation's inherited grant must skip a remote chunk key reached through its hunk work.
test("preparation skips a remotely held nested chunk and returns", async () => {
  const s = await setup();
  try {
    writeFileSync(join(s.repository, "readme.md"), "fixture changed\n");
    git("-C", s.repository, "add", ".");
    git(
      "-C",
      s.repository,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.test",
      "commit",
      "-qm",
      "changed",
    );
    const fixture = "shared-grant-process.ts";
    const holder = s.spawn(
      { operation: "chunks", holdOp: "harness.blob-chunks" },
      s.repository,
      {},
      fixture,
    );
    await holder.wait("run");
    const preparation = s.spawn(
      { operation: "preparation", inside: true },
      s.repository,
      {},
      fixture,
    );
    expect((await preparation.wait("result")).count).toBe(0);
    expect(
      preparation.events.some(
        (event) => event.event === "role" && event.role === "held",
      ),
    ).toBe(true);
    holder.send("run");
    await holder.wait("result");
  } finally {
    await s.close();
  }
}, 60_000);

// Why: both hosted and floor computations must preserve a caller's single JSON stdout receipt.
for (const hosted of [true, false])
  test(`default logger preserves JSON stdout, hosted=${hosted}`, async () => {
    const s = await setup(hosted);
    try {
      const child = Bun.spawn(
        [
          process.execPath,
          "--no-env-file",
          join(import.meta.dir, "fixtures/shared-stdout-process.ts"),
        ],
        {
          env: {
            ...process.env,
            NEUVE_BUDGET_DIRECTORY: join(s.root, "budget"),
            NEUVE_SHARED_TEST: JSON.stringify({ repository: s.repository }),
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
      expect(code).toBe(0);
      expect(JSON.parse(stdout)).toEqual({
        status: "computed",
        value: "receipt",
      });
      if (!hosted)
        expect(stderr).toContain(
          '"type":"shared-work.floor","floor":"unreachable"',
        );
    } finally {
      await s.close();
    }
  }, 60_000);
