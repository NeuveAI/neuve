// Why: account status sentences must reach both CLI surfaces intact, while direct routes
// retain the credential wording. The store and held file are real; only worker IPC is faked.
import { afterEach, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Effect, Layer } from "effect";
import {
  JobQueue,
  Starter,
  Worker,
  mintUlid,
  resolveStoreLocation,
} from "@neuve/records-core";
import { heldReviewsPath, type HeldReview } from "@neuve/harness/held-reviews";
import { execute, withStore } from "../src/records-cli.ts";
import { follow } from "../src/review-cli.ts";
import { runJobsCli } from "../src/worker-cli.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

for (const provider of ["claude", "openai"] as const)
  test(`${provider} held wording in review follow and jobs`, async () => {
    const root = mkdtempSync(join(tmpdir(), "held-wording-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const previousHome = process.env.HOME;
    process.env.HOME = root;
    cleanups.push(() => {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    });
    const repo = join(root, "repo");
    expect(Bun.spawnSync(["git", "init", "-q", repo]).exitCode).toBe(0);
    const { job } = await execute(
      withStore(
        repo,
        "create",
        JobQueue.JobQueue.use((queue) =>
          queue.enqueue({
            kind: "review.run@2",
            dedupeKey: "review.run:held-wording:0",
          }),
        ).pipe(Effect.provide(JobQueue.layer)),
      ),
    );
    const location = await Effect.runPromise(resolveStoreLocation(repo));
    const db = new Database(join(location.directory, "records.sqlite"));
    cleanups.push(() => db.close());
    const at = new Date().toISOString();
    db.query(
      "INSERT INTO worker_state (id, pid, socket, started_at, last_progress_at, last_progress) VALUES (1, ?, ?, ?, ?, ?)",
    ).run(process.pid, "fixture", at, at, "holding review");
    const credential =
      provider === "claude"
        ? "Claude Code sign-in is unknown. Run neuve auth status claude --check"
        : "the Neuve sign-in";
    const held: HeldReview = {
      seq: job.seq,
      pid: process.pid,
      at,
      provider,
      route: `${provider}/opus`,
      credential,
    };
    const path = heldReviewsPath(location);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify([held]));
    const output: string[] = [];
    const write = spyOn(Bun, "write").mockImplementation(
      async (_destination, data) => {
        output.push(String(data));
        return Buffer.byteLength(String(data));
      },
    );
    cleanups.push(() => write.mockRestore());
    expect(await runJobsCli(["--repo", repo])).toBe(0);
    expect(output.join("")).toContain(
      provider === "claude"
        ? `held: worker pid ${process.pid} holds it for claude/opus. ${credential}`
        : `held: worker pid ${process.pid} lacks the Neuve sign-in for openai/opus; a worker that has it picks the job up`,
    );
    output.length = 0;
    const starter = spyOn(Starter, "ensureWorker").mockReturnValue(
      Effect.succeed({ status: "running", socket: "fixture" }),
    );
    cleanups.push(() => starter.mockRestore());
    let notices = 0;
    let closed = false;
    const subscribe = spyOn(Worker, "subscribeJob").mockImplementation(
      async () => ({
        next: async () => {
          if (++notices <= 2) return "held";
          db.query("UPDATE jobs SET state = 'completed' WHERE job_seq = ?").run(
            job.seq,
          );
          return "changed";
        },
        close: () => {
          closed = true;
        },
      }),
    );
    cleanups.push(() => subscribe.mockRestore());
    expect(await follow(repo, location, job.seq, mintUlid())).toBe(0);
    const line =
      provider === "claude"
        ? `Waiting: the running worker (pid ${process.pid}) holds this job for claude/opus. ${credential}.`
        : `Waiting: the running worker (pid ${process.pid}) lacks the Neuve sign-in for openai/opus, so it holds this job; a worker that has it picks it up.`;
    expect(output.filter((part) => part.includes("Waiting:"))).toEqual([
      `${line}\n`,
    ]);
    expect(closed).toBe(true);
  });
