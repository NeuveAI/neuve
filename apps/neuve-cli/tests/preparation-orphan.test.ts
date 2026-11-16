import { afterAll, expect, test } from "bun:test";
import { graphTestPrerequisite } from "../../../scripts/graph-test-prerequisite.ts";
import { spawn } from "node:child_process";
import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  existsSync,
  fstatSync,
  openSync,
  readFileSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  fakeExecutable,
  fixtureRepository,
  removeRoots,
} from "../../../packages/graph-client/tests/graph-client-support.ts";
import {
  stopHeavyChild,
  CHILD_STOP_GRACE_MS,
} from "../../../packages/harness/src/heavy-child.ts";

const isRunning = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// Why: under 16 CPU burners the engine was already exiting with ppid 1 and stat E, but kill(pid, 0)
// still succeeded. This instant ordering check must count exited, unreaped grandchildren as stopped.
const processStatus = (pid: number): string | undefined => {
  const status = Bun.spawnSync(["/bin/ps", "-o", "stat=", "-p", String(pid)], {
    stdout: "pipe",
    stderr: "ignore",
  });
  return status.exitCode === 0 ? status.stdout.toString().trim() : undefined;
};
const hasStopped = (
  pid: number,
  readStatus: (pid: number) => string | undefined = processStatus,
): boolean => {
  if (!isRunning(pid)) return true;
  try {
    const status = readStatus(pid);
    if (status) return /[ZE]/.test(status);
  } catch {
    // A sandbox can refuse ps; only a PID that has since disappeared counts as stopped.
  }
  return !isRunning(pid);
};

// Why: launchd may reap an exiting engine between kill(pid, 0) and ps; unreadable status alone is not an exit.
test.each([
  ["failed", "gone"],
  ["empty", "gone"],
  ["throwing", "gone"],
  ["failed", "present"],
  ["empty", "present"],
  ["throwing", "present"],
])("the grandchild oracle handles %s status with PID %s", (status, present) => {
  let lookupFinished = false;
  const probe = spyOn(process, "kill").mockImplementation(() => {
    if (lookupFinished && present === "gone") throw new Error("ESRCH");
    return true;
  });
  try {
    expect(
      hasStopped(process.pid, () => {
        lookupFinished = true;
        if (status === "throwing") throw new Error("Status unavailable");
        return status === "empty" ? "" : undefined;
      }),
    ).toBe(present === "gone");
  } finally {
    probe.mockRestore();
  }
});

// Why: treating an unreaped exit as stopped must never treat a live engine as stopped.
test("the instant grandchild oracle rejects a running process", async () => {
  const child = Bun.spawn(["sleep", "60"], {
    stdout: "ignore",
    stderr: "ignore",
  });
  try {
    expect(hasStopped(child.pid)).toBe(false);
    child.kill("SIGKILL");
    await child.exited;
    expect(hasStopped(child.pid)).toBe(true);
  } finally {
    child.kill("SIGKILL");
    await child.exited;
  }
});

/** A pid file exists before its contents do, and signalling pid 0 would hit this test's own group. */
const writtenPid = async (path: string) => {
  for (let i = 0; i < 500; i++) {
    const pid = Number(readFileSync(path, "utf8"));
    if (pid > 1) return pid;
    await Bun.sleep(10);
  }
  throw new Error(`No pid in ${path}`);
};

/**
 * Fails an open store on every platform. Deleting it fails it only on macOS, whose SQLite reports a
 * file unlinked while open; Linux keeps writing to the unlinked files. The files keep their size, as
 * truncating the mapped `-shm` file would crash the process that maps it.
 */
const zeroStore = (database: string) => {
  for (const path of [database, `${database}-wal`, `${database}-shm`]) {
    if (!existsSync(path)) continue;
    const fd = openSync(path, "r+");
    try {
      const length = Math.min(fstatSync(fd).size, 65_536);
      writeSync(fd, Buffer.alloc(length), 0, length, 0);
    } finally {
      closeSync(fd);
    }
  }
};

test.each([
  ["prepare-code", ""],
  ["prepare-commit", ""],
  // Why: the child can exit before a timer of its own would have escalated.
  ["prepare-commit", 'process.on("SIGTERM", () => {});'],
])(
  "%s interrupts Graph's detached engine before the child stops %s",
  async (kind, engineOnStop) => {
    const repo = await fixtureRepository();
    const executable = await fakeExecutable("prepared-service-answered");
    const directory = dirname(executable);
    const pidFile = join(directory, "engine.pid");
    writeFileSync(
      executable,
      readFileSync(executable, "utf8").replace(
        "const command = process.argv[2];",
        `const command = process.argv[2];\nif (command === "index") { ${engineOnStop} writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); await Bun.sleep(60000); }`,
      ),
    );
    const child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        join(import.meta.dir, "fixtures/preparation-orphan.ts"),
        repo.root,
        repo.second,
        executable,
        join(directory, "cache"),
        kind,
      ],
      { env: { ...process.env }, stdout: "ignore", stderr: "ignore" },
    );
    let engine: number | undefined;
    try {
      for (let i = 0; !existsSync(pidFile) && i < 1000; i++)
        await Bun.sleep(10);
      expect(existsSync(pidFile)).toBe(true);
      engine = await writtenPid(pidFile);
      const started = performance.now();
      await stopHeavyChild(child);
      expect(child.exitCode).toBe(143);
      expect(performance.now() - started).toBeLessThan(CHILD_STOP_GRACE_MS);
      for (let i = 0; isRunning(engine) && i < 200; i++) await Bun.sleep(10);
      expect(isRunning(engine)).toBe(false);
    } finally {
      if (engine !== undefined)
        try {
          process.kill(-engine, "SIGKILL");
        } catch {}
      await stopHeavyChild(child);
      await removeRoots();
    }
  },
  30000,
);

// Why: a stopping child can wait on the lifecycle lock past its grace, and the SIGKILL that follows
// runs no exit hook, so Graph has to be stopped when the signal arrives.
test("prepare-commit stops Graph's engine while its finalizer waits on a lock", async () => {
  const repo = await fixtureRepository();
  const executable = await fakeExecutable("prepared-service-answered");
  const directory = dirname(executable);
  const pidFile = join(directory, "engine.pid");
  writeFileSync(
    executable,
    readFileSync(executable, "utf8").replace(
      "const command = process.argv[2];",
      `const command = process.argv[2];\nif (command === "index") { writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); await Bun.sleep(60000); }`,
    ),
  );
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      join(import.meta.dir, "fixtures/preparation-orphan.ts"),
      repo.root,
      repo.second,
      executable,
      join(directory, "cache"),
      "prepare-commit",
    ],
    { env: { ...process.env }, stdout: "ignore", stderr: "ignore" },
  );
  let engine: number | undefined;
  let release = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let held: Promise<void> | undefined;
  try {
    for (let i = 0; !existsSync(pidFile) && i < 1000; i++) await Bun.sleep(10);
    expect(existsSync(pidFile)).toBe(true);
    engine = await writtenPid(pidFile);
    const location = await Effect.runPromise(resolveStoreLocation(repo.root));
    await new Promise<void>((locked) => {
      held = withStoreLock(
        join(location.directory, "code-work", "lifecycle"),
        async () => {
          locked();
          await released;
        },
      );
    });
    child.kill("SIGTERM");
    for (let i = 0; isRunning(engine) && i < 500; i++) await Bun.sleep(10);
    expect(isRunning(engine)).toBe(false);
    expect(child.exitCode).toBeNull();
  } finally {
    release();
    await held;
    if (engine !== undefined)
      try {
        process.kill(-engine, "SIGKILL");
      } catch {}
    await stopHeavyChild(child);
    await removeRoots();
  }
}, 30000);

import { spyOn } from "bun:test";
import * as os from "node:os";
import { Effect, Option } from "effect";
import {
  Blobs,
  Computations,
  JobQueue,
  Worker,
  resolveStoreLocation,
  storeLocationIn,
} from "@neuve/records-core";
import { runOn } from "../../../packages/records-core/tests/support.ts";
import {
  hostBudget,
  closeWorkerBudget,
} from "../../../packages/harness/src/budget/local.ts";
import { runPreparationChild } from "../../../packages/harness/src/commit-prepare.ts";
import { withCodeWork } from "../../../packages/harness/src/code-work.ts";
import { withStoreLock } from "../../../packages/harness/src/stack/store.ts";

test("a review stops preparation's detached Graph engine before releasing its grant", async () => {
  const repo = await fixtureRepository();
  const executable = await fakeExecutable("prepared-service-answered");
  const directory = dirname(executable),
    pidFile = join(directory, "engine.pid");
  writeFileSync(
    executable,
    readFileSync(executable, "utf8").replace(
      "const command = process.argv[2];",
      `const command = process.argv[2];\nif (command === "index") { writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); await Bun.sleep(60000); }`,
    ),
  );
  const budgetDirectory = join(directory, "budget");
  const host = await hostBudget({
    directory: budgetDirectory,
    threads: 4,
    efficiency: 4,
    fixed: 4,
  });
  if (!host) throw new Error("No fixture host");
  const previous = process.env.NEUVE_BUDGET_DIRECTORY;
  process.env.NEUVE_BUDGET_DIRECTORY = budgetDirectory;
  const location = storeLocationIn(join(directory, "store"));
  const controller = new AbortController();
  const run = Effect.runPromise(
    runPreparationChild(
      {
        repository: repo.root,
        location,
        command: [
          process.execPath,
          join(import.meta.dir, "fixtures/preparation-orphan.ts"),
        ],
      },
      [repo.root, repo.second, executable, join(directory, "cache")],
    ),
    { signal: controller.signal },
  );
  let completed = false;
  void run.then(
    () => {
      completed = true;
    },
    () => {},
  );
  run.catch(() => {});
  let engine: number | undefined;
  try {
    for (let i = 0; !existsSync(pidFile) && i < 1000; i++) await Bun.sleep(10);
    expect(existsSync(pidFile)).toBe(true);
    engine = await writtenPid(pidFile);
    expect((await host.scheduler.observe()).held).toBeGreaterThan(0);
    await Effect.runPromise(
      withCodeWork(
        location,
        false,
        Effect.promise(async () => {
          const started = performance.now();
          for (
            let i = 0;
            (await host.scheduler.observe()).held > 0 && i < 600;
            i++
          )
            await Bun.sleep(10);
          expect((await host.scheduler.observe()).held).toBe(0);
          expect(performance.now() - started).toBeLessThan(CHILD_STOP_GRACE_MS);
          expect(hasStopped(engine!)).toBe(true);
          await Bun.sleep(100);
          expect(completed).toBe(false);
          controller.abort();
          await run.catch(() => {});
        }),
      ),
    );
  } finally {
    controller.abort();
    await run.catch(() => {});
    if (engine !== undefined)
      try {
        process.kill(-engine, "SIGKILL");
      } catch {}
    await host.close();
    await closeWorkerBudget(budgetDirectory);
    if (previous === undefined) delete process.env.NEUVE_BUDGET_DIRECTORY;
    else process.env.NEUVE_BUDGET_DIRECTORY = previous;
    await removeRoots();
  }
}, 30000);

test("host loss fails a real preparation attempt and the worker retries it", async () => {
  const repo = await fixtureRepository();
  const executable = await fakeExecutable("prepared-service-answered");
  const directory = dirname(executable);
  const pidFile = join(directory, "engine.pid");
  writeFileSync(
    executable,
    readFileSync(executable, "utf8").replace(
      "const command = process.argv[2];",
      `import { existsSync } from "node:fs"; const command = process.argv[2];\nif (command === "index" && !existsSync(${JSON.stringify(pidFile)})) { writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); await Bun.sleep(60000); }`,
    ),
  );
  const budgetDirectory = join(directory, "budget");
  const host = await hostBudget({
    directory: budgetDirectory,
    threads: 4,
    efficiency: 4,
    fixed: 4,
  });
  if (!host) throw new Error("No fixture host");
  const previous = process.env.NEUVE_BUDGET_DIRECTORY;
  process.env.NEUVE_BUDGET_DIRECTORY = budgetDirectory;
  const location = storeLocationIn(join(directory, "store"));
  const attempts: number[] = [];
  let failedAttempt: JobQueue.Job | undefined;
  const run = runOn(
    location,
    Effect.gen(function* () {
      const queue = yield* JobQueue.JobQueue;
      const queued = yield* queue.enqueue({
        kind: "commit.prepare@2",
        dedupeKey: "host-loss",
      });
      yield* Worker.run({
        location,
        idleTimeout: "100 millis",
        pollInterval: "10 millis",
        eachTurn: Effect.gen(function* () {
          const job = Option.getOrThrow(yield* queue.inspect(queued.job.seq));
          if (job.state === "delayed") failedAttempt = job;
        }),
        handlers: {
          "commit.prepare@2": (job) => {
            attempts.push(job.attempts);
            return runPreparationChild(
              {
                repository: repo.root,
                location,
                command: [
                  process.execPath,
                  join(import.meta.dir, "fixtures/preparation-orphan.ts"),
                ],
              },
              [repo.root, repo.second, executable, join(directory, "cache")],
            );
          },
        },
      });
      return Option.getOrThrow(yield* queue.inspect(queued.job.seq));
    }).pipe(
      Effect.provide(JobQueue.layer),
      Effect.provide(Computations.layer),
      Effect.provide(Blobs.layer(location)),
      Effect.timeout("20 seconds"),
    ),
  );
  void run.catch(() => {});
  try {
    for (let i = 0; !existsSync(pidFile) && i < 1000; i++) await Bun.sleep(10);
    expect(existsSync(pidFile)).toBe(true);
    await host.close();
    const job = await run;
    expect(failedAttempt?.lastError?.tag).toBe("CommitPrepareFailed");
    expect(failedAttempt?.lastError?.message).toContain("exited 143");
    expect(attempts).toEqual([1, 2]);
    expect(job.state).toBe("completed");
    expect(job.attempts).toBe(2);
  } finally {
    await run.catch(() => {});
    if (existsSync(pidFile)) {
      try {
        process.kill(-Number(readFileSync(pidFile, "utf8")), "SIGKILL");
      } catch {}
    }
    await host.close();
    await closeWorkerBudget(budgetDirectory);
    if (previous === undefined) delete process.env.NEUVE_BUDGET_DIRECTORY;
    else process.env.NEUVE_BUDGET_DIRECTORY = previous;
    await removeRoots();
  }
}, 30000);

// Why these exist: a killed worker left children spinning for hours on the owner's Mac, and nothing
// else in the suite notices a process that outlives the test which started it.
test.each([
  ["names itself", "0"],
  ["names no one", "1"],
])(
  "a preparation child stops itself after its worker is killed, when the worker %s",
  async (_, unnamed) => {
    const repo = await fixtureRepository();
    const directory = dirname(
      await fakeExecutable("prepared-service-answered"),
    );
    const location = storeLocationIn(join(directory, "store"));
    let child: number | undefined;
    let parent: ReturnType<typeof Bun.spawn> | undefined;
    try {
      // A review's marker holds the child at its code-work checkpoint, so it never ends by itself.
      await Effect.runPromise(
        withCodeWork(
          location,
          false,
          Effect.promise(async () => {
            parent = Bun.spawn(
              [
                process.execPath,
                "--no-env-file",
                join(import.meta.dir, "fixtures/preparation-parent.ts"),
                "worker",
                "prepare-code",
                "--repo",
                repo.root,
                "--store",
                location.directory,
                "--input",
                JSON.stringify({
                  kind: "range",
                  range: { baseOid: repo.first, headOid: repo.second },
                }),
              ],
              {
                stdin: "ignore",
                stdout: "pipe",
                stderr: "ignore",
                env: { ...process.env, PREPARATION_PARENT_UNNAMED: unnamed },
              },
            );
            let output = "";
            const decoder = new TextDecoder();
            for await (const part of parent.stdout as ReadableStream<Uint8Array>) {
              output += decoder.decode(part);
              child ??= Number(/^child (\d+)$/m.exec(output)?.[1]) || undefined;
              if (output.includes("yielding code work")) break;
            }
            expect(output).toContain("yielding code work");
            // From before the kill: within the grace, it cannot have been the guard's SIGKILL.
            const started = performance.now();
            parent.kill("SIGKILL");
            await parent.exited;
            while (
              isRunning(child!) &&
              performance.now() - started < CHILD_STOP_GRACE_MS
            )
              await Bun.sleep(25);
            // Inside the grace: it stopped on the guard's SIGTERM, not on the kill that follows it.
            expect(isRunning(child!)).toBe(false);
          }),
        ),
      );
    } finally {
      if (parent !== undefined) parent.kill("SIGKILL");
      if (child !== undefined && isRunning(child))
        process.kill(child, "SIGKILL");
      await removeRoots();
    }
  },
  30000,
);

test("a child whose output has closed still exits with its failure", async () => {
  const child = spawn(
    process.execPath,
    [
      "--no-env-file",
      join(import.meta.dir, "../src/cli.ts"),
      "worker",
      "prepare-code",
      "--input",
      "not json",
      "--parent-pid",
      String(process.pid),
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const exited = new Promise<number | null>((resolve) =>
    child.once("exit", (code) => resolve(code)),
  );
  child.stdout?.destroy();
  child.stderr?.destroy();
  try {
    const code = await Promise.race([exited, Bun.sleep(20_000)]);
    expect(code).toBe(2);
  } finally {
    child.kill("SIGKILL");
  }
}, 30000);

test("a worker whose store fails stops its child before it exits", async () => {
  const repo = await fixtureRepository();
  const directory = dirname(await fakeExecutable("prepared-service-answered"));
  const pidFile = join(directory, "child.pid");
  const budgetDirectory = join(directory, "budget");
  const host = await hostBudget({
    directory: budgetDirectory,
    threads: 4,
    efficiency: 4,
    fixed: 4,
  });
  if (!host) throw new Error("No fixture host");
  const previous = process.env.NEUVE_BUDGET_DIRECTORY;
  process.env.NEUVE_BUDGET_DIRECTORY = budgetDirectory;
  const location = storeLocationIn(join(directory, "store"));
  const run = runOn(
    location,
    Effect.gen(function* () {
      const queue = yield* JobQueue.JobQueue;
      yield* queue.enqueue({
        kind: "commit.prepare@2",
        dedupeKey: "store-loss",
      });
      yield* Worker.run({
        location,
        idleTimeout: "1 minute",
        pollInterval: "10 millis",
        handlers: {
          "commit.prepare@2": () =>
            runPreparationChild(
              {
                repository: repo.root,
                location,
                command: [
                  process.execPath,
                  join(import.meta.dir, "fixtures/slow-stopping-child.ts"),
                ],
              },
              [pidFile],
            ),
        },
      });
    }).pipe(
      Effect.provide(JobQueue.layer),
      Effect.provide(Computations.layer),
      Effect.provide(Blobs.layer(location)),
      Effect.timeout("20 seconds"),
    ),
  );
  void run.catch(() => {});
  let child: number | undefined;
  try {
    for (let i = 0; !existsSync(pidFile) && i < 1000; i++) await Bun.sleep(10);
    expect(existsSync(pidFile)).toBe(true);
    child = await writtenPid(pidFile);
    zeroStore(location.database);
    const failure = await run.then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeDefined();
    expect(failure).not.toMatchObject({ _tag: "TimeoutError" });
    expect(hasStopped(child)).toBe(true);
  } finally {
    await run.catch(() => {});
    if (child !== undefined && isRunning(child)) process.kill(child, "SIGKILL");
    await host.close();
    await closeWorkerBudget(budgetDirectory);
    if (previous === undefined) delete process.env.NEUVE_BUDGET_DIRECTORY;
    else process.env.NEUVE_BUDGET_DIRECTORY = previous;
    await removeRoots();
  }
}, 30000);

// Why: a failed heavy child used to discard the cause, hiding the Graph command that failed.
test("a preparation failure names its bounded cause chain on one line", async () => {
  const repo = await fixtureRepository();
  const executable = await fakeExecutable("prepared-service-answered");
  const directory = dirname(executable);
  writeFileSync(
    executable,
    readFileSync(executable, "utf8").replace(
      "const command = process.argv[2];",
      `const command = process.argv[2]; if (command === "version") { console.error("x".repeat(4000) + " final diagnostic"); process.exit(23); }`,
    ),
  );
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      join(import.meta.dir, "fixtures/preparation-orphan.ts"),
      repo.root,
      repo.second,
      executable,
      join(directory, "cache"),
    ],
    { stdout: "ignore", stderr: "pipe" },
  );
  try {
    const [code, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
    ]);
    expect(code).toBe(2);
    const failure = stderr
      .split("\n")
      .filter((line) => line.startsWith("neuve: "));
    expect(failure).toHaveLength(1);
    expect(failure[0]).toStartWith(
      "neuve: GraphPreparationError: Graph snapshot preparation did not complete.",
    );
    expect(failure[0]).toContain("cause: Error: Graph version exited with 23.");
    expect(failure[0]).toContain("final diagnostic");
    expect(failure[0]!.length).toBeLessThanOrEqual(2100);
  } finally {
    child.kill("SIGKILL");
    await child.exited;
    await removeRoots();
  }
}, 30000);

const graphSource = join(import.meta.dir, "../../neuve-graph");
const go = Bun.which("go");
const graphPrerequisite = graphTestPrerequisite({
  available: go !== null && existsSync(join(graphSource, "cmd/entire-graph")),
  message:
    go === null
      ? "Go is missing from PATH. Install the Go toolchain required by apps/neuve-graph/go.mod and add go to PATH."
      : "Graph source is absent at apps/neuve-graph. Run `git submodule update --init --recursive -- apps/neuve-graph` from the workspace root.",
});
let engineBuildDirectory: string | undefined;
let engineBuild: Promise<string> | undefined;
afterAll(() => {
  if (engineBuildDirectory !== undefined)
    rmSync(engineBuildDirectory, { recursive: true, force: true });
});
const builtEngine = (): Promise<string> =>
  (engineBuild ??= (async () => {
    if (go === null) throw new Error("No Go compiler");
    engineBuildDirectory = mkdtempSync(
      join(os.tmpdir(), "neuve-orphan-engine-"),
    );
    const binary = join(engineBuildDirectory, "entire-graph");
    const build = Bun.spawn([go, "build", "-o", binary, "./cmd/entire-graph"], {
      cwd: graphSource,
      env: { ...process.env },
      stdout: "ignore",
      stderr: "pipe",
    });
    const [code, stderr] = await Promise.all([
      build.exited,
      new Response(build.stderr).text(),
    ]);
    if (code !== 0) throw new Error(`Graph build exited ${code}: ${stderr}`);
    return binary;
  })());

// Why: SIGKILL runs no finalizer. The remote check has neither Graph source nor Go, so these real-engine cases run in the local check.
test.skipIf(graphPrerequisite.skip).each(["prepare-code", "prepare-commit"])(
  "SIGKILL of %s stops a real indexing engine and its group within five seconds",
  async (kind) => {
    graphPrerequisite.require();
    const binary = await builtEngine();
    const repo = await fixtureRepository();
    const executable = await fakeExecutable("prepared-service-answered");
    const directory = dirname(executable);
    const shimDirectory = join(directory, "shim");
    mkdirSync(shimDirectory);
    const enginePidFile = join(directory, "engine.pid"),
      gitPidFile = join(directory, "git.pid");
    const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
    const realGit = Bun.which("git");
    if (!realGit) throw new Error("No git");
    writeFileSync(
      join(shimDirectory, "git"),
      `#!/bin/sh\nfor arg do\n if [ "$arg" = ls-tree ]; then\n echo $$ > ${quote(gitPidFile)}\n exec sleep 60\n fi\ndone\nexec ${quote(realGit)} "$@"\n`,
      { mode: 0o700 },
    );
    // Only discovery goes through this launcher, whose identity is deliberately unreported.
    // index replaces the launcher with the built engine; PATH holds its first ls-tree deterministically.
    writeFileSync(
      executable,
      `#!/bin/sh\nif [ "$1" = version ]; then\n echo '{"identity_revision":"2","provider":"entire-graph","version":"dev"}'\n exit 0\nfi\nif [ "$1" = index ]; then\n echo $$ > ${quote(enginePidFile)}\n export PATH=${quote(shimDirectory)}:"$PATH"\nfi\nexec ${quote(binary)} "$@"\n`,
    );
    const child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        join(import.meta.dir, "fixtures/preparation-orphan.ts"),
        repo.root,
        repo.second,
        executable,
        join(directory, "cache"),
        kind,
      ],
      {
        env: { ...process.env, ENTIRE_GRAPH_SERVICE: "off" },
        stdout: "ignore",
        stderr: "pipe",
      },
    );
    let engine: number | undefined, git: number | undefined;
    try {
      const deadline = Date.now() + 15000;
      while (
        !existsSync(gitPidFile) &&
        Date.now() < deadline &&
        child.exitCode === null
      )
        await Bun.sleep(10);
      if (!existsSync(gitPidFile))
        throw new Error(
          `Index did not reach Git: ${child.exitCode === null ? "still starting" : await new Response(child.stderr).text()}`,
        );
      engine = await writtenPid(enginePidFile);
      git = await writtenPid(gitPidFile);
      expect(isRunning(engine)).toBe(true);
      expect(isRunning(git)).toBe(true);
      child.kill("SIGKILL");
      await child.exited;
      const stoppedBy = Date.now() + 5000;
      const groupRunning = () => {
        try {
          process.kill(-engine!, 0);
          return true;
        } catch {
          return false;
        }
      };
      // Why: an exited, unreaped engine or Git can still answer kill(pid, 0) after its group disappears.
      while (
        (groupRunning() || !hasStopped(engine) || !hasStopped(git)) &&
        Date.now() < stoppedBy
      )
        await Bun.sleep(10);
      expect(hasStopped(engine)).toBe(true);
      expect(hasStopped(git)).toBe(true);
      expect(groupRunning()).toBe(false);
    } finally {
      child.kill("SIGKILL");
      await child.exited;
      if (engine !== undefined)
        try {
          process.kill(-engine, "SIGKILL");
        } catch {}
      await removeRoots();
    }
  },
  120000,
);

// Why: logging only the first cause still loses the original failure, and embedded newlines split logs.
test("a preparation failure retains nested causes on the same line", async () => {
  const repo = await fixtureRepository();
  const executable = await fakeExecutable("prepared-service-answered");
  const directory = dirname(executable);
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      join(import.meta.dir, "fixtures/preparation-orphan.ts"),
      repo.root,
      repo.second,
      executable,
      join(directory, "cache"),
      "failure-chain",
    ],
    { stdout: "ignore", stderr: "pipe" },
  );
  try {
    const [code, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
    ]);
    expect(code).toBe(2);
    expect(stderr).toBe(
      "neuve: outer failure (cause: Error: middle line) (cause: Error: root line)\n",
    );
  } finally {
    child.kill("SIGKILL");
    await child.exited;
    await removeRoots();
  }
}, 30000);
