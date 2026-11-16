// Why: a peer Records client can write during the worker's immutable pre-bind read.
// That uncertainty must reach the acceptance transaction; unrelated I/O failures must fail startup.
import { expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { DatabaseSync } from "node:sqlite";
import {
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { Effect, Layer } from "effect";
import {
  Blobs,
  Computations,
  JobQueue,
  Store,
  Worker,
  storeLocationIn,
  resolveStoreLocation,
} from "../src/index.ts";
import { claimWorkerLock } from "../src/worker-socket.ts";

import { workerSuite } from "./worker-suite.ts";
import { markSetUp } from "../../../apps/neuve-cli/tests/fixtures/set-up.ts";

const workers = workerSuite();

for (const legacy of ["none", "observed", "late"] as const) {
  test(`worker pre-bind peer writer: ${legacy} legacy claim`, async () => {
    const root = mkdtempSync(join(tmpdir(), "worker-prebind-"));
    const location = storeLocationIn(root);
    let writer: Database | undefined;
    let hook: ReturnType<typeof spyOn> | undefined;
    let runs = 0;
    const path = await Effect.runPromise(Worker.socketPathFor(location));
    const legacyRow = `INSERT INTO worker_state VALUES (1, 42, 'legacy.sock', 'then', 'then', 'legacy')`;
    try {
      await Effect.runPromise(
        Effect.andThen(
          Store.prepareForWrite,
          JobQueue.JobQueue.use((queue) =>
            queue.enqueue({ kind: "worker.probe", dedupeKey: "peer-writer" }),
          ),
        ).pipe(
          Effect.provide(JobQueue.layer),
          Effect.provide(Store.layer(location, { create: true })),
          Effect.provide(BunFileSystem.layer),
        ),
      );
      const closed = new DatabaseSync(location.database);
      if (legacy === "observed") closed.exec(legacyRow);
      closed.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      closed.close();
      expect(existsSync(`${location.database}-wal`)).toBe(false);
      const original = DatabaseSync.prototype.exec;
      hook = spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (
        this: DatabaseSync,
        sql: string,
      ) {
        const result = original.call(this, sql);
        if (sql === "BEGIN" && writer === undefined) {
          expect(existsSync(path)).toBe(false);
          writer = new Database(location.database);
          writer.exec("CREATE TABLE peer_admission (id INTEGER)");
          if (legacy === "late") writer.exec(legacyRow);
        }
        return result;
      });
      const began = performance.now();
      const result = await Effect.runPromise(
        Worker.withStartup(
          location,
          Effect.andThen(
            Store.prepareForWrite,
            Worker.run({
              location,
              handlers: {
                "worker.probe": () =>
                  Effect.sync(() => {
                    runs++;
                  }),
              },
              idleTimeout: "1 millis",
            }),
          ).pipe(
            Effect.provide(
              Layer.mergeAll(
                JobQueue.layer,
                Computations.layer.pipe(
                  Layer.provideMerge(Blobs.layer(location)),
                ),
              ),
            ),
            Effect.provide(Store.layer(location, { create: true })),
          ),
        ).pipe(Effect.provide(BunFileSystem.layer)),
      );
      const elapsed = performance.now() - began;
      if (legacy === "late") {
        console.error("late legacy refusal elapsed ms", elapsed);
        expect(elapsed).toBeLessThan(5000);
      }
      expect(writer).toBeDefined();
      expect(result.reason).toBe(legacy === "none" ? "idle" : "another-worker");
      expect(runs).toBe(legacy === "none" ? 1 : 0);
      expect(
        writer!.query("SELECT pid FROM worker_state WHERE id=1").get(),
      ).toEqual(legacy === "none" ? null : { pid: 42 });
      expect(existsSync(path)).toBe(false);
      const lock = await Effect.runPromise(
        claimWorkerLock(
          (await Effect.runPromise(Worker.workerPathsFor(location))).lock,
        ),
      );
      expect(lock).toBeDefined();
      lock?.close();
    } finally {
      hook?.mockRestore();
      writer?.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("worker pre-bind read tolerates a real peer review admission", async () => {
  const owner = await workers.start();
  const root = mkdtempSync(join(tmpdir(), "review2-worker-peer-"));
  const settings = join(root, "settings.json");
  writeFileSync(settings, JSON.stringify({ version: 1 }));
  const repo = join(root, "repo");
  let hook: ReturnType<typeof spyOn> | undefined;
  try {
    expect(Bun.spawnSync(["git", "init", "-q", repo]).exitCode).toBe(0);
    // Reviews refuse a repository until `neuve setup` has run there.
    await markSetUp(repo);
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
    git("config", "user.name", "Fixture");
    git("config", "user.email", "fixture@example.com");
    const commits: string[] = [];
    for (const text of ["a", "b", "c"]) {
      writeFileSync(join(repo, "a.txt"), `${text}\n`);
      git("add", ".");
      git("commit", "-qm", text);
      commits.push(git("rev-parse", "HEAD"));
    }
    const admit = (range: string) => {
      const result = Bun.spawnSync(
        [
          process.execPath,
          "--no-env-file",
          `${import.meta.dir}/../../../apps/neuve-cli/tests/fixtures/fresh-store-review.ts`,
          repo,
          range,
          "writer",
          "foreground",
        ],
        {
          stdin: new Uint8Array(0),
          stdout: "pipe",
          stderr: "pipe",
          env: {
            ...process.env,
            ...owner.env,
            ANTHROPIC_API_KEY: "fixture-never-used",
            FRESH_STORE_SETTINGS: settings,
          },
        },
      );
      expect(result.exitCode, result.stderr.toString()).toBe(0);
    };
    admit(`${commits[0]}..${commits[1]}`);
    const location = await Effect.runPromise(resolveStoreLocation(repo));
    const db = new DatabaseSync(location.database);
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    db.close();
    // Settle the file before taking its identity, never after the peer writes.
    utimesSync(location.database, 1, 1);
    expect(existsSync(`${location.database}-wal`)).toBe(false);
    let wrote = false;
    const original = DatabaseSync.prototype.exec;
    hook = spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (
      this: DatabaseSync,
      sql: string,
    ) {
      const result = original.call(this, sql);
      if (sql === "BEGIN" && !wrote) {
        wrote = true;
        admit(`${commits[1]}..${commits[2]}`);
      }
      return result;
    });
    const result = await Effect.runPromise(
      Effect.result(
        Worker.withStartup(
          location,
          Effect.andThen(
            Store.prepareForWrite,
            Worker.run({ location, handlers: {}, idleTimeout: "1 millis" }),
          ).pipe(
            Effect.provide(
              Layer.mergeAll(
                JobQueue.layer,
                Computations.layer.pipe(
                  Layer.provideMerge(Blobs.layer(location)),
                ),
              ),
            ),
            Effect.provide(Store.layer(location, { create: true })),
          ),
        ),
      ).pipe(Effect.provide(BunFileSystem.layer)),
    );
    console.error("worker-peer-admission result", result);
    expect(wrote).toBe(true);
    const check = new DatabaseSync(location.database, { readOnly: true });
    try {
      expect(check.prepare("PRAGMA integrity_check").get()).toEqual({
        integrity_check: "ok",
      });
    } finally {
      check.close();
    }
    expect(result._tag).toBe("Success");
    if (result._tag === "Success") expect(result.success.reason).toBe("idle");
  } finally {
    hook?.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
});

test("worker pre-bind read propagates an I/O error and its original cause", async () => {
  const root = mkdtempSync(join(tmpdir(), "worker-prebind-io-"));
  const location = storeLocationIn(root);
  let hook: ReturnType<typeof spyOn> | undefined;
  const cause = Object.assign(new Error("fixture disk read failed"), {
    code: "EIO",
  });
  try {
    await Effect.runPromise(
      Store.prepareForWrite.pipe(
        Effect.provide(Store.layer(location, { create: true })),
        Effect.provide(BunFileSystem.layer),
      ),
    );
    const original = DatabaseSync.prototype.exec;
    hook = spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (
      this: DatabaseSync,
      sql: string,
    ) {
      if (sql === "BEGIN") throw cause;
      return original.call(this, sql);
    });
    let entered = false;
    const result = await Effect.runPromise(
      Effect.result(
        Worker.withStartup(
          location,
          Effect.sync(() => {
            entered = true;
            return { reason: "idle" } as const;
          }),
        ),
      ).pipe(Effect.provide(BunFileSystem.layer)),
    );
    expect(entered).toBe(false);
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.failure).toBeInstanceOf(Worker.WorkerSocketUnavailable);
      if (result.failure instanceof Worker.WorkerSocketUnavailable)
        expect(result.failure.cause).toBe(cause);
    }
    expect(
      existsSync(await Effect.runPromise(Worker.socketPathFor(location))),
    ).toBe(false);
  } finally {
    hook?.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
});
