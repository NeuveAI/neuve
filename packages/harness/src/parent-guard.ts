import { Worker } from "node:worker_threads";

/**
 * Stops this process once `parent` has gone, however it went. Without `graceMs` it is killed at
 * once; with it, it gets SIGTERM first, so its finalizers can stop what it started, and is killed if
 * still running after `graceMs`.
 */
export const monitorParent = (parent: number, graceMs?: number) => {
  const worker = new Worker(
    new URL(
      import.meta.url.endsWith(".ts")
        ? "./parent-guard-worker.ts"
        : "./parent-guard-worker.js",
      import.meta.url,
    ),
    { workerData: { parent, graceMs } },
  );
  worker.unref();
  return () => worker.terminate();
};

/**
 * Kills what a process started, for just before it is killed itself: a SIGKILL runs nothing there, so
 * its children, and the groups they lead, would outlive it. `ps` answers for a process too stuck to
 * say what it started.
 */
export const killChildrenOf = (parent: number) => {
  try {
    const listing = Bun.spawnSync(["/bin/ps", "-axo", "pid=,ppid=,pgid="], {
      stdout: "pipe",
      stderr: "ignore",
      timeout: 1_000,
    });
    for (const line of listing.stdout.toString().split("\n")) {
      const [pid, ppid, group] = line.trim().split(/\s+/).map(Number);
      if (!pid || ppid !== parent) continue;
      try {
        process.kill(group === pid ? -pid : pid, "SIGKILL");
      } catch {
        // It has gone.
      }
    }
  } catch {
    // No listing to act on. Killing the process itself must still go ahead.
  }
};
