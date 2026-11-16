// A dropped preparation must stop its child while the review continues.
import { expect, test } from "bun:test";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  existsSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { Effect, Deferred } from "effect";
import {
  Log,
  JobQueue,
  Computations,
  Worker,
  storeLocationIn,
} from "@neuve/records-core";
import { commitEvent } from "../../records-core/tests/support.ts";
import { commitPrepareHandler } from "../src/commit-prepare.ts";
import { stopHeavyChild } from "../src/heavy-child.ts";
import { runIn, value } from "./pi/capture/fixture.ts";

test("dropping a running preparation during a review stops its child", async () => {
  const root = mkdtempSync(join(tmpdir(), "heavy-child-drop-"));
  const location = storeLocationIn(join(root, "store"));
  const marker = join(root, "spawned");
  const script = join(root, "child.ts");
  writeFileSync(
    script,
    `await Bun.write(${JSON.stringify(marker)}, "started"); await Bun.sleep(60000);`,
  );
  let interrupted = false;
  try {
    const exit = value(
      await runIn(location)(
        Effect.gen(function* () {
          const queue = yield* JobQueue.JobQueue;
          yield* queue.enqueue({ kind: "review.run", dedupeKey: "review" });
          yield* Log.append([commitEvent("a".repeat(40))]);
          const waiting = yield* Deferred.make<void>();
          const stopped = yield* Deferred.make<void>();
          yield* Effect.forkChild(
            Effect.gen(function* () {
              yield* Deferred.await(waiting);
              for (let n = 0; !existsSync(marker) && n < 200; n++)
                yield* Effect.sleep("10 millis");
              expect(existsSync(marker)).toBe(true);
              const path = yield* Worker.socketPathFor(location);
              const state = yield* Worker.reachWorker(path, "status");
              if (state._tag !== "Answered")
                return yield* Effect.die("worker unavailable");
              const seq = JSON.parse(state.reply).slots.background.seq;
              yield* Worker.reachWorker(path, `drop ${seq}`);
              yield* Deferred.await(stopped).pipe(Effect.timeout("2 seconds"));
            }),
          );
          const prepare = commitPrepareHandler({
            repository: root,
            location,
            command: [process.execPath, "--no-env-file", script],
          });
          return yield* Worker.run({
            location,
            idleTimeout: "100 millis",
            pollInterval: "10 millis",
            handlers: {
              "review.run": () =>
                Effect.gen(function* () {
                  yield* Deferred.await(stopped).pipe(
                    Effect.timeout("3 seconds"),
                  );
                  yield* Effect.sleep("100 millis");
                }),
              "commit.prepare": (job) =>
                Effect.gen(function* () {
                  yield* Deferred.succeed(waiting, undefined);
                  yield* prepare(job).pipe(
                    Effect.onInterrupt(() =>
                      Effect.gen(function* () {
                        interrupted = true;
                        yield* Deferred.succeed(stopped, undefined);
                      }),
                    ),
                  );
                }),
            },
          });
        }).pipe(
          Effect.provide(JobQueue.layer),
          Effect.provide(Computations.layer),
        ),
      ),
    );
    expect(exit.reason).toBe("idle");
    expect(interrupted).toBe(true);
    expect(existsSync(marker)).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 15000);

test("cancelled stack fetch handler lets its child stop the detached fetch group", async () => {
  const { stackFetchHandler } = await import("../src/stack/handler.ts");
  const { emptyRepoStack, writeRepoStack } =
    await import("../src/stack/repo-state.ts");
  const { Fiber } = await import("effect");
  const root = mkdtempSync(join(tmpdir(), "heavy-child-term-"));
  const location = storeLocationIn(join(root, "store"));
  const marker = join(root, "group-pid");
  const term = join(root, "term");
  const script = join(root, "child.ts");
  const watched = fileURLToPath(
    new URL("../src/stack/git-store.ts", import.meta.url),
  );
  writeFileSync(
    script,
    `
    import { runWatched } from ${JSON.stringify(watched)};
    const controller = new AbortController();
    process.on("SIGTERM", () => { Bun.write(${JSON.stringify(term)}, "TERM"); controller.abort(); });
    await runWatched(["/bin/sh", "-c", ${JSON.stringify(`echo $$ > '${marker}'; exec sleep 60`)}], { PATH:"/usr/bin:/bin" }, {
      watch: ${JSON.stringify(root)}, capBytes:10000000, timeoutMs:60000, killGraceMs:5000, signal:controller.signal,
    }).catch(() => {});
    process.exit(0);
  `,
  );
  let group = 0;
  try {
    await writeRepoStack(location.directory, emptyRepoStack(true));
    value(
      await runIn(location)(
        Effect.scoped(
          Effect.gen(function* () {
            const queue = yield* JobQueue.JobQueue;
            const queued = yield* queue.enqueue({
              kind: "stack.fetch",
              dedupeKey: "term",
              payload: { reason: "setup", revisions: ["a".repeat(40)] },
            });
            const job = queued.job;
            const fiber = yield* Effect.forkChild(
              stackFetchHandler({
                repository: root,
                location,
                home: root,
                command: [process.execPath, "--no-env-file", script],
              })(job),
            );
            for (let n = 0; !existsSync(marker) && n < 200; n++)
              yield* Effect.sleep("10 millis");
            expect(existsSync(marker)).toBe(true);
            group = Number(
              yield* Effect.promise(() => Bun.file(marker).text()),
            );
            yield* Fiber.interrupt(fiber);
          }),
        ).pipe(
          Effect.provide(JobQueue.layer),
          Effect.provide(Computations.layer),
        ),
      ),
    );
    expect(existsSync(term)).toBe(true);
    let alive = true;
    try {
      process.kill(-group, 0);
    } catch {
      alive = false;
    }
    expect(alive).toBe(false);
  } finally {
    if (group > 0)
      try {
        process.kill(-group, "SIGKILL");
      } catch {}
    rmSync(root, { recursive: true, force: true });
  }
}, 15000);

test("preparation launch failure stays a typed CommitPrepareFailed", async () => {
  const { Cause } = await import("effect");
  const root = mkdtempSync(join(tmpdir(), "heavy-child-fail-"));
  const location = storeLocationIn(join(root, "store"));
  try {
    const result = value(
      await runIn(location)(
        Effect.gen(function* () {
          yield* Log.append([commitEvent("b".repeat(40))]);
          const queue = yield* JobQueue.JobQueue;
          const job = yield* queue.take(["commit.prepare"]);
          if (job._tag === "None") return yield* Effect.die("no job");
          return yield* Effect.exit(
            commitPrepareHandler({
              repository: root,
              location,
              command: [join(root, "missing-binary")],
            })(job.value),
          );
        }).pipe(
          Effect.provide(JobQueue.layer),
          Effect.provide(Computations.layer),
        ),
      ),
    );
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(Cause.hasDies(result.cause)).toBe(false);
      expect(Cause.squash(result.cause)).toMatchObject({
        _tag: "CommitPrepareFailed",
      });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a running capture scan does not hold commit preparation's slot", async () => {
  const root = mkdtempSync(join(tmpdir(), "capture-slot-"));
  const location = storeLocationIn(join(root, "store"));
  const order: string[] = [];
  try {
    value(
      await runIn(location)(
        Effect.gen(function* () {
          const queue = yield* JobQueue.JobQueue;
          yield* queue.enqueue({ kind: "capture.scan", dedupeKey: "scan" });
          yield* queue.enqueue({
            kind: "commit.prepare",
            dedupeKey: "prepare",
          });
          const scanning = yield* Deferred.make<void>();
          const prepared = yield* Deferred.make<void>();
          yield* Worker.run({
            location,
            idleTimeout: "100 millis",
            pollInterval: "10 millis",
            handlers: {
              "capture.scan": () =>
                Effect.gen(function* () {
                  order.push("scan starts");
                  yield* Deferred.succeed(scanning, undefined);
                  yield* Deferred.await(prepared).pipe(
                    Effect.timeout("2 seconds"),
                  );
                  order.push("scan ends");
                }),
              "commit.prepare": () =>
                Effect.gen(function* () {
                  yield* Deferred.await(scanning);
                  order.push("prepare ends");
                  yield* Deferred.succeed(prepared, undefined);
                }),
            },
          });
        }).pipe(
          Effect.provide(JobQueue.layer),
          Effect.provide(Computations.layer),
        ),
      ),
    );
    expect(order).toEqual(["scan starts", "prepare ends", "scan ends"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 15000);

const blockedChild = join(import.meta.dir, "fixtures/blocked-child.ts");
const running = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// Why: a child too stuck to run its finalizers is killed, and that would leave what it started running.
test.skipIf(!existsSync("/bin/ps")).each([
  ["its guard", "guarded"],
  ["its worker", "unguarded"],
])(
  "a blocked child killed by %s takes its own children with it",
  async (_stopper, guard) => {
    const root = mkdtempSync(join(tmpdir(), "heavy-child-stop-"));
    const pidFile = join(root, `${guard}.json`);
    const child = Bun.spawn([process.execPath, blockedChild, pidFile, guard!], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    let started: number[] = [];
    try {
      for (let i = 0; !existsSync(pidFile) && i < 1000; i++)
        await Bun.sleep(10);
      for (let i = 0; started.length === 0 && i < 100; i++) {
        try {
          started = JSON.parse(readFileSync(pidFile, "utf8"));
        } catch {
          await Bun.sleep(10);
        }
      }
      expect(started).toHaveLength(2);
      // Before the guard can have fired: a child that never started would prove nothing.
      if (guard === "unguarded") {
        expect(started.every(running)).toBe(true);
        await stopHeavyChild(child);
      }
      await child.exited;
      expect(child.signalCode).toBe("SIGKILL");
      for (let i = 0; started.some(running) && i < 200; i++)
        await Bun.sleep(10);
      expect(started.filter(running)).toEqual([]);
    } finally {
      child.kill("SIGKILL");
      for (const pid of started)
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
      rmSync(root, { recursive: true, force: true });
    }
  },
  30000,
);
