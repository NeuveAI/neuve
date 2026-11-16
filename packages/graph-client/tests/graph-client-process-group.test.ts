import { afterEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { runGraphInspection } from "../src/index.ts";
import {
  fakeExecutable,
  fixtureRepository,
  removeRoots,
  request,
  waitForFile,
} from "./graph-client-support.ts";

afterEach(removeRoots);

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const waitUntilGone = async (
  pid: number,
  withinMs: number,
): Promise<boolean> => {
  const deadline = Date.now() + withinMs;
  while (alive(pid)) {
    if (Date.now() >= deadline) return false;
    await Bun.sleep(20);
  }
  return true;
};

// The engine's writeFileSync creates the file before it writes the pid, so an empty read is retried:
// Number("") is 0, and kill(0) signals this test's own process group.
const pidFrom = async (path: string): Promise<number> => {
  const deadline = Date.now() + 2_000;
  for (;;) {
    const pid = Number((await readFile(path, "utf8")).trim());
    if (Number.isSafeInteger(pid) && pid > 0) return pid;
    if (Date.now() >= deadline) throw new Error(`No pid in ${path}.`);
    await Bun.sleep(10);
  }
};

describe("engine process group", () => {
  // A timed-out or aborted inspection used to SIGTERM the engine's pid only, leaving a long
  // `git grep` child scanning as an orphan. The engine now leads its own process group and the
  // whole group is stopped: SIGTERM, then SIGKILL for an engine that does not exit.
  test.each(["orphan-child", "orphan-child-stubborn"])(
    "an aborted inspection leaves no engine child running (%s)",
    async (mode) => {
      const repository = await fixtureRepository();
      const executable = await fakeExecutable(mode);
      const control = dirname(executable);
      const controller = new AbortController();
      const pending = runGraphInspection(
        request(executable, repository.root, repository.first, false),
        { signal: controller.signal, emit: async () => {} },
      );
      await waitForFile(join(control, "child-pid"));
      await waitForFile(join(control, "engine-pid"));
      const child = await pidFrom(join(control, "child-pid"));
      const engine = await pidFrom(join(control, "engine-pid"));
      try {
        expect(alive(child)).toBe(true);
        controller.abort();
        await expect(pending).rejects.toThrow("Graph inspection aborted.");
        expect(await waitUntilGone(child, 5_000)).toBe(true);
        expect(await waitUntilGone(engine, 5_000)).toBe(true);
      } finally {
        for (const pid of [child, engine].filter(
          (pid) => Number.isSafeInteger(pid) && pid > 0,
        ))
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            // Already gone.
          }
      }
    },
    20_000,
  );

  // Why: nothing cancels a command whose engine has already gone, so its `git grep` would scan on.
  test("an engine that dies leaves no child running", async () => {
    const repository = await fixtureRepository();
    const executable = await fakeExecutable("orphan-child");
    const control = dirname(executable);
    const pending = runGraphInspection(
      request(executable, repository.root, repository.first, false),
      { emit: async () => {} },
    ).catch(() => {});
    await waitForFile(join(control, "child-pid"));
    await waitForFile(join(control, "engine-pid"));
    const child = await pidFrom(join(control, "child-pid"));
    const engine = await pidFrom(join(control, "engine-pid"));
    try {
      expect(alive(child)).toBe(true);
      process.kill(engine, "SIGKILL");
      expect(await waitUntilGone(child, 5_000)).toBe(true);
      await pending;
    } finally {
      for (const pid of [child, engine])
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // Already gone.
        }
    }
  }, 20_000);

  // Why: the escalation is a timer in the caller, and a caller stopping now would take it with it.
  test("a caller exiting just after its engine died still stops what ignores SIGTERM", async () => {
    const repository = await fixtureRepository();
    const executable = await fakeExecutable("orphan-child-ignoring");
    const control = dirname(executable);
    const caller = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        join(import.meta.dir, "fixtures/exiting-caller.ts"),
        executable,
        repository.root,
        repository.first,
      ],
      { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
    );
    let child: number | undefined;
    let engine: number | undefined;
    try {
      await waitForFile(join(control, "child-pid"));
      await waitForFile(join(control, "engine-pid"));
      child = await pidFrom(join(control, "child-pid"));
      engine = await pidFrom(join(control, "engine-pid"));
      process.kill(engine, "SIGKILL");
      caller.kill("SIGTERM");
      await caller.exited;
      expect(await waitUntilGone(child, 1_000)).toBe(true);
    } finally {
      caller.kill("SIGKILL");
      for (const pid of [child, engine])
        if (pid !== undefined)
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            // Already gone.
          }
    }
  }, 20_000);
});
