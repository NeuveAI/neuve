// A linked worktree can disappear while the shared worker is still serving its repository.
import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { text } from "node:stream/consumers";
import { Effect, Option } from "effect";
import {
  JobQueue,
  Starter,
  Worker,
  resolveStoreLocation,
} from "@neuve/records-core";
import { execute, withStore } from "../src/records-cli.ts";

test("the shared worker prepares a range after its starting worktree is removed", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "neuve-wt-")));
  const main = join(root, "main checkout");
  const first = join(root, "first");
  const next = join(root, "next");
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", ...args]);
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    return result.stdout.toString().trim();
  };
  const commit = (repository: string, message: string) => {
    git(
      "-C",
      repository,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "-c",
      "commit.gpgSign=false",
      "-c",
      "core.hooksPath=/dev/null",
      "commit",
      "-qm",
      message,
      "--allow-empty",
    );
    return git("-C", repository, "rev-parse", "HEAD");
  };
  try {
    git("init", "-q", main);
    const baseOid = commit(main, "base");
    git("-C", main, "worktree", "add", "--detach", "-q", first);
    const worker = spawn(
      process.execPath,
      [
        ...Starter.sourceRunFlags(),
        join(import.meta.dir, "../src/cli.ts"),
        "worker",
        "run",
        "--repo",
        first,
      ],
      {
        cwd: first,
        env: {
          ...process.env,
          HOME: root,
          TMPDIR: root,
          NEUVE_TEST_PROCESS: "1",
          NEUVE_BUDGET_DIRECTORY: join(root, "budget"),
          NEUVE_WORKER_READY_FD: "3",
        },
        stdio: ["ignore", "pipe", "pipe", "pipe"],
      },
    );
    const closed = new Promise<void>((resolve, reject) => {
      worker.once("error", reject);
      worker.once("close", () => resolve());
    });
    const timer = setTimeout(() => worker.kill("SIGKILL"), 20_000);
    let stdout: Promise<string>;
    try {
      const ready = worker.stdio[3];
      if (!(ready instanceof Readable) || !worker.stdout || !worker.stderr)
        throw new Error("worker output pipes are missing");
      stdout = text(worker.stdout);
      const stderr = text(worker.stderr);
      if ((await text(ready)) !== "ready\n")
        throw new Error((await stderr) || "worker exited before readiness");
      git("-C", main, "worktree", "remove", first);
      git("-C", main, "worktree", "add", "--detach", "-q", next);
      const headOid = commit(next, "head");
      const location = await execute(resolveStoreLocation(next));
      const queue = <A, E>(
        mode: "read" | "write",
        use: (queue: JobQueue.JobQueue["Service"]) => Effect.Effect<A, E>,
      ) =>
        execute(
          withStore(
            next,
            mode,
            JobQueue.JobQueue.use(use).pipe(Effect.provide(JobQueue.layer)),
            location,
          ),
        );
      const { job } = await queue("write", (queue) =>
        queue.enqueue({
          kind: "commit.prepare@2",
          dedupeKey: "prepare-after-worktree-removal",
          payload: { kind: "range", range: { baseOid, headOid } },
        }),
      );
      const deadline = AbortSignal.timeout(12_000);
      const subscription = await Worker.subscribeJob(
        location,
        job.seq,
        deadline,
      );
      try {
        await execute(Worker.reachStoreWorker(location, "wake"));
        let subscriptionError: string | undefined;
        for (;;) {
          const state = Option.getOrThrow(
            await queue("read", (queue) => queue.inspect(job.seq)),
          );
          if (
            subscriptionError !== undefined ||
            state.state === "completed" ||
            state.lastError !== null ||
            state.state === "failed"
          ) {
            const { lastError } = state;
            expect(
              state.state,
              lastError === null
                ? subscriptionError
                : `${lastError.tag}: ${lastError.message}`,
            ).toBe("completed");
            break;
          }
          try {
            await subscription.next();
          } catch (error) {
            if (
              error !== deadline.reason &&
              !(error instanceof Worker.WorkerSubscriptionLost)
            )
              throw error;
            subscriptionError = String(error);
          }
        }
      } finally {
        subscription.close();
      }
    } finally {
      worker.kill("SIGTERM");
      await closed;
      clearTimeout(timer);
    }
    expect(await stdout).toContain(`worker starting for ${main} (`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 25_000);
