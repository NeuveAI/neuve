// Idle success, interruption and failure must terminate the real store-worker process.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { Worker, storeLocationIn } from "@neuve/records-core";
import { processAlive } from "../../../packages/records-core/tests/worker-process.ts";
const cli = join(import.meta.dir, "../src/cli.ts");
for (const mode of ["idle", "signal", "failure"] as const)
  test(`store worker exits on ${mode}`, async () => {
    const root = mkdtempSync(join(tmpdir(), "capture-worker-exit-"));
    if (mode === "failure")
      writeFileSync(join(root, "blocked"), "not a directory");
    const location = storeLocationIn(
      mode === "failure" ? join(root, "blocked") : root,
    );
    const child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        cli,
        "worker",
        "run",
        "--store",
        location.directory,
        "--idle-seconds",
        mode === "signal" ? "60" : "1",
      ],
      {
        env: { ...process.env, HOME: root, TMPDIR: root },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const out = new Response(child.stdout).text();
    const err = new Response(child.stderr).text();
    try {
      if (mode === "signal") {
        const socket = await Effect.runPromise(Worker.socketPathFor(location));
        let ready = false;
        for (let n = 0; n < 200; n++) {
          if (
            (
              await Effect.runPromise(
                Worker.reachWorker(socket, "status", "100 millis"),
              )
            )._tag === "Answered"
          ) {
            ready = true;
            break;
          }
          await Bun.sleep(25);
        }
        expect(ready).toBe(true);
        child.kill("SIGTERM");
      }
      const code = await Promise.race([
        child.exited,
        Bun.sleep(8000).then(() => "still running"),
      ]);
      expect(code).toBe(mode === "failure" ? 2 : 0);
      expect(processAlive(child.pid)).toBe(false);
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
      await child.exited;
      await Promise.all([out, err]);
      rmSync(root, { recursive: true, force: true });
    }
  }, 15000);
