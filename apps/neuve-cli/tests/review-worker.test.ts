// Why: this build enqueues reviews as `review.run@2`, which builds before 12.24 never take, and a
// project has one worker socket. When an older build's worker (started by the installed copy's
// hooks) holds it, a review queued from the workspace must still be run by this build's worker,
// with no manual step, once the older one idles out; and with no worker at all, at once. Real
// worker processes over the real socket and a scratch store show both. Binding the socket needs a
// host that allows it; the Claude sandbox does not.
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as ChildProcess from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Effect, Layer } from "effect";
import { z } from "zod";
import {
  Blobs,
  Computations,
  JobQueue,
  Worker,
  resolveStoreLocation,
} from "@neuve/records-core";
import { execute, withStore } from "../src/records-cli.ts";
import {
  keepWorkerFor,
  rearmWaitingReviews,
  thisBuild,
  WORKER_RECHECK_MS,
} from "../src/review-worker.ts";

import { workerSuite } from "../../../packages/records-core/tests/worker-suite.ts";

const workers = workerSuite();
let owner: Awaited<ReturnType<typeof workers.start>>;
const spawn = ChildProcess.spawn;
let spawnSpy: ReturnType<typeof spyOn<typeof ChildProcess, "spawn">>;
beforeEach(async () => {
  owner = await workers.start();
  spawnSpy = spyOn(ChildProcess, "spawn").mockImplementation(
    new Proxy(spawn, {
      apply(target, receiver, args) {
        const [file, argv, options] = args;
        const probe = resolve(
          import.meta.dir,
          "fixtures/worker-process-probe.ts",
        );
        const childArgs = argv.includes(
          resolve(import.meta.dir, "../src/cli.ts"),
        )
          ? ["--preload", probe, ...argv]
          : argv;
        const child: ReturnType<typeof spawn> = Reflect.apply(
          target,
          receiver,
          [
            file,
            childArgs,
            {
              ...options,
              env: { ...process.env, ...options?.env, ...owner.env },
            },
          ],
        );
        owner.child(child.pid);
        return child;
      },
    }),
  );
});

const FIXTURE = resolve(import.meta.dir, "fixtures/review-worker.ts");

const directories: Array<string> = [];
const children: Array<ReturnType<typeof Bun.spawn>> = [];
afterEach(async () => {
  spawnSpy.mockRestore();
  const owned = children.splice(0);
  for (const child of owned) child.kill();
  await Promise.all(owned.map((child) => child.exited));
  await Promise.all(
    directories.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});

const canBind = (() => {
  const path = `/tmp/neuve-bind-${process.pid}.sock`;
  try {
    const server = Bun.listen({ unix: path, socket: { data() {} } });
    server.stop(true);
    return true;
  } catch {
    return false;
  } finally {
    rmSync(path, { force: true });
  }
})();

/** A repository with one waiting `review.run@2` job, as the workspace's admission leaves it. */
const queued = async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "neuve-keep-")));
  directories.push(root);
  const repo = join(root, "repo");
  Bun.spawnSync(["git", "init", "-q", repo]);
  const job = await execute(
    withStore(repo, "create", (location) =>
      JobQueue.JobQueue.use((queue) =>
        queue.enqueue({ kind: "review.run@2", dedupeKey: "review.run:keep:0" }),
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            JobQueue.layer,
            Computations.layer.pipe(Layer.provideMerge(Blobs.layer(location))),
          ),
        ),
      ),
    ),
  );
  const marker = join(root, "marker.log");
  await writeFile(marker, "");
  return { root, repo, seq: job.job.seq, marker };
};

const lines = (marker: string) =>
  readFileSync(marker, "utf8")
    .split("\n")
    .filter((line) => line !== "");

const keep = (repo: string, seq: number, marker: string) => {
  process.env["REVIEW_WORKER_MARKER"] = marker;
  return keepWorkerFor({
    project: repo,
    job: seq,
    command: [process.execPath, FIXTURE],
    watchMs: 30_000,
  });
};

const settledAs = async (marker: string, line: string) => {
  for (let waited = 0; waited < 20_000; waited += 100) {
    if (lines(marker).includes(line)) return true;
    await Bun.sleep(100);
  }
  return false;
};

test.skipIf(!canBind)(
  "with no worker running, this build's worker is started and takes the review",
  async () => {
    const { repo, seq, marker } = await queued();
    const kept = await keep(repo, seq, marker);
    expect(await settledAs(marker, `this build review.run@2 ${seq}`)).toBe(
      true,
    );
    expect(["active", "completed"]).toContain((await kept.settled) ?? "none");
  },
  30_000,
);

test.skipIf(!canBind)(
  "an older build's worker holding the socket is waited out, then this build's worker takes the review",
  async () => {
    const { repo, seq, marker } = await queued();
    const location = await Effect.runPromise(resolveStoreLocation(repo));
    const socket = await Effect.runPromise(Worker.socketPathFor(location));
    const older = Bun.spawn(
      [process.execPath, FIXTURE, "older", repo, "1500", marker],
      {
        detached: true,
        env: { ...process.env, ...owner.env },
        stdout: "ignore",
        stderr: "ignore",
      },
    );
    owner.child(older.pid);
    children.push(older);
    for (let waited = 0; waited < 10_000; waited += 50) {
      if (existsSync(socket)) break;
      await Bun.sleep(50);
    }
    const kept = await keep(repo, seq, marker);
    // The older worker never takes it, idles out, and only then this build's worker runs it.
    expect(await settledAs(marker, `this build review.run@2 ${seq}`)).toBe(
      true,
    );
    const seen = lines(marker);
    expect(seen.indexOf("older exited")).toBeGreaterThanOrEqual(0);
    expect(seen.indexOf("older exited")).toBeLessThan(
      seen.indexOf(`this build review.run@2 ${seq}`),
    );
    expect(seen.some((line) => line.startsWith("older review"))).toBe(false);
    expect(["active", "completed"]).toContain((await kept.settled) ?? "none");
  },
  30_000,
);

test.skipIf(!canBind)(
  "a review this build's worker holds ends the watch, so no worker is started again and again",
  async () => {
    const { repo, seq, marker } = await queued();
    process.env["REVIEW_WORKER_HOLD"] = "1";
    try {
      const kept = await keep(repo, seq, marker);
      expect(await kept.settled).toBe("held");
      await Bun.sleep(2 * WORKER_RECHECK_MS);
      expect(
        lines(marker).filter((line) => line === "this build started"),
      ).toHaveLength(1);
      expect(lines(marker).some((line) => line.includes("review.run@2"))).toBe(
        false,
      );
    } finally {
      delete process.env["REVIEW_WORKER_HOLD"];
    }
  },
  30_000,
);

// Why: the worker this build starts runs in the reviewed project's folder and holds route
// credentials, so bun must load nothing from that folder: not its `.env`, and not its
// `bunfig.toml`, whose preload runs code. This starts the real worker through the real default
// command and looks at what reached it.
test.skipIf(!canBind)(
  "the worker this build starts loads neither the project's .env nor its bunfig.toml preload",
  async () => {
    const { root, repo } = await queued();
    const home = join(root, "home");
    mkdirSync(home, { recursive: true });
    const preloaded = join(root, "preloaded");
    await writeFile(
      join(repo, "preload.ts"),
      `require("node:fs").writeFileSync(${JSON.stringify(preloaded)}, "ran");\n`,
    );
    await writeFile(join(repo, "bunfig.toml"), 'preload = ["./preload.ts"]\n');
    await writeFile(join(repo, ".env"), "NEUVE_PROJECT_ENV_MARKER=leaked\n");
    // Plain bun in that folder loads both, so the test can see either reach a process.
    const probe = join(root, "probe.ts");
    await writeFile(
      probe,
      'console.log(process.env.NEUVE_PROJECT_ENV_MARKER ?? "absent");\n',
    );
    const plain = Bun.spawnSync([process.execPath, probe], {
      cwd: repo,
      env: { ...process.env, HOME: home },
      stdout: "pipe",
    });
    expect(plain.stdout.toString().trim()).toBe("leaked");
    expect(await Bun.file(preloaded).exists()).toBe(true);
    await rm(preloaded);

    expect(thisBuild()).toContain("--no-env-file");
    expect(thisBuild().some((arg) => arg.startsWith("--config="))).toBe(true);
    const previous = process.env["HOME"];
    process.env["HOME"] = home;
    let pid: number | undefined;
    try {
      // A job that does not exist: the keeper asks for a worker once, then stops watching.
      await (
        await keepWorkerFor({ project: repo, job: 999_999 })
      ).settled;
      const recorded = owner.pids();
      expect(recorded).toHaveLength(1);
      pid = recorded[0];
      expect(pid).toBeDefined();
      // Started from this checkout with the flags, and given time for any preload to run.
      await Bun.sleep(1_500);
      const seen = z
        .object({
          argv: z.array(z.string()),
          projectEnv: z.string().nullable(),
        })
        .parse(
          JSON.parse(
            readFileSync(join(owner.directory, `${pid}.json`), "utf8"),
          ),
        );
      expect(seen.argv).toContain("--no-env-file");
      expect(seen.argv.some((arg) => arg.startsWith("--config="))).toBe(true);
      expect(seen.argv).toContain(resolve(import.meta.dir, "../src/cli.ts"));
      expect(seen.projectEnv).toBeNull();
      expect(await Bun.file(preloaded).exists()).toBe(false);
    } finally {
      if (previous === undefined) delete process.env["HOME"];
      else process.env["HOME"] = previous;
    }
  },
  40_000,
);

// Why: a review queued before the host last stopped would otherwise wait with no keeper. On start
// the host finds such reviews through the registry of stores, reading each store without opening
// it for writing, and re-arms only this build's waiting reviews on its own volume, including `/`.
test("on host start, only this build's waiting reviews on the volume are re-armed", async () => {
  const waiting = await queued();
  const other = await queued();
  // The second store's review already ran, and an older build's review waits there.
  await execute(
    withStore(other.repo, "write", (location) =>
      JobQueue.JobQueue.use((queue) =>
        Effect.gen(function* () {
          const taken = yield* queue.take(["review.run@2"]);
          if (taken._tag === "Some")
            yield* queue.complete(taken.value.seq, taken.value.attempts);
          yield* queue.enqueue({
            kind: "review.run",
            dedupeKey: "review.run:old:0",
          });
        }),
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            JobQueue.layer,
            Computations.layer.pipe(Layer.provideMerge(Blobs.layer(location))),
          ),
        ),
      ),
    ),
  );
  const registry = join(waiting.root, "repositories.json");
  const entry = async (repo: string) => ({
    store: (await Effect.runPromise(resolveStoreLocation(repo))).directory,
    repository: repo,
  });
  await writeFile(
    registry,
    JSON.stringify({
      version: 1,
      repositories: [
        await entry(waiting.repo),
        await entry(other.repo),
        { store: "/nowhere/neuve", repository: "/nowhere" },
      ],
    }),
  );
  const kept: Array<{ project: string; job: number }> = [];
  const armed = await rearmWaitingReviews({
    within: await realpath(tmpdir()),
    registry,
    keep: async (job) => kept.push(job),
  });
  expect(armed).toEqual([{ project: waiting.repo, job: waiting.seq }]);
  expect(kept).toEqual([...armed]);
  const rootKept: Array<{ project: string; job: number }> = [];
  const rootArmed = await rearmWaitingReviews({
    within: "/",
    registry,
    keep: async (job) => rootKept.push(job),
  });
  expect(rootArmed).toEqual(armed);
  expect(rootKept).toEqual([...armed]);
  // A volume the stores are not on re-arms nothing.
  expect(
    await rearmWaitingReviews({
      within: join(waiting.root, "elsewhere"),
      registry,
      keep: async (job) => kept.push(job),
    }),
  ).toEqual([]);
});
