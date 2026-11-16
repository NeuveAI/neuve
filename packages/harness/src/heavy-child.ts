import { killChildrenOf, monitorParent } from "./parent-guard.ts";

/** Stack fetches get five seconds to stop their detached groups after their parent receives TERM. */
export const CHILD_STOP_GRACE_MS = 6_000;

/** The flag that names the spawning worker to a heavy child (`guardWorkerChild`). */
export const workerParentArgs = () => ["--parent-pid", String(process.pid)];

/**
 * A worker that crashes or is killed cannot stop its heavy child, whose work would then have no
 * owner. So the child watches its worker from its own thread, as the guard must work while the
 * child's main thread is blocked, and stops the same way a worker would stop it.
 */
export const guardWorkerChild = (worker: number) =>
  monitorParent(worker, CHILD_STOP_GRACE_MS);

export const stopHeavyChild = async (child: {
  readonly pid: number;
  readonly exitCode: number | null;
  readonly exited: Promise<number>;
  readonly kill: (signal: NodeJS.Signals) => void;
}) => {
  if (child.exitCode !== null) {
    await child.exited;
    return;
  }
  child.kill("SIGTERM");
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    child.exited,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, CHILD_STOP_GRACE_MS);
    }),
  ]);
  clearTimeout(timer);
  if (child.exitCode === null) {
    killChildrenOf(child.pid);
    child.kill("SIGKILL");
  }
  await child.exited;
};
