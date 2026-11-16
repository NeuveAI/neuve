import { workerData } from "node:worker_threads";
import { killChildrenOf } from "./parent-guard.ts";

// This thread can stop a synchronously blocked child after its parent dies.
const parent = Number(workerData.parent);
const graceMs: number | undefined = workerData.graceMs;
const child = process.pid;
if (!Number.isSafeInteger(parent) || parent < 1) process.kill(child, "SIGKILL");
const stop = () => {
  clearInterval(watch);
  if (graceMs === undefined) {
    process.kill(child, "SIGKILL");
    return;
  }
  process.kill(child, "SIGTERM");
  setTimeout(() => {
    killChildrenOf(child);
    process.kill(child, "SIGKILL");
  }, graceMs);
};
const watch = setInterval(() => {
  if (process.ppid !== parent) return stop();
  try {
    process.kill(parent, 0);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH")
      stop();
  }
}, 250);
