// A heavy child whose main thread never runs again, with one child in its own group and one not.
import { writeFileSync } from "node:fs";
import { monitorParent } from "../../src/parent-guard.ts";
const [pidFile, guard] = Bun.argv.slice(2);
if (!pidFile) throw new Error("Missing pid file");
const start = (detached: boolean) =>
  Bun.spawn(["sleep", "60"], {
    detached,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  }).pid;
// As `runMain` has it: SIGTERM waits for a main thread that will never take it.
process.on("SIGTERM", () => process.exit(143));
writeFileSync(pidFile, JSON.stringify([start(true), start(false)]));
// A parent this process does not have, so the guard acts at once.
if (guard === "guarded") monitorParent(Number.MAX_SAFE_INTEGER, 100);
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
