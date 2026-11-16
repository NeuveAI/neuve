// `bun run test`: the root tests and the workspace pool as before, then each failed file rerun alone and reported.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  finishRun,
  loadSampler,
  REPORT_ENV,
  RUN_DIRECTORY_ENV,
} from "./test-report.ts";

const sequential = [
  process.execPath,
  "run",
  "--sequential",
  "--no-exit-on-error",
  "test:root",
  "test:workspaces",
];

const run = async () => {
  // Inside another run (a rerun of this script): run the pair and leave the reruns and report to the outer run.
  if (process.env[RUN_DIRECTORY_ENV])
    return await Bun.spawn(sequential, {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    }).exited;
  const directory = mkdtempSync(join(tmpdir(), "neuve-test-run-"));
  const report = process.env[REPORT_ENV];
  const sampler = loadSampler();
  let stopped = 0;
  let child: ReturnType<typeof Bun.spawn> | undefined;
  const stop = (code: number, signal: NodeJS.Signals) => () => {
    stopped ||= code;
    // A terminal's Ctrl-C reaches the whole group; a signal sent to this runner alone is passed on.
    child?.kill(signal);
  };
  const interrupt = stop(130, "SIGINT");
  const terminate = stop(143, "SIGTERM");
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  try {
    child = Bun.spawn(sequential, {
      env: {
        ...process.env,
        [RUN_DIRECTORY_ENV]: directory,
        [REPORT_ENV]: undefined,
      },
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    const code = await child.exited;
    child = undefined;
    return await finishRun({
      directory,
      samples: sampler.samples,
      runCode: stopped || code,
      interrupted: stopped !== 0 || code === 130 || code === 143,
      stopped: () => stopped,
      root: { cwd: process.cwd(), script: "test:root" },
      ...(report ? { report } : {}),
    });
  } finally {
    sampler.stop();
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", terminate);
    rmSync(directory, { recursive: true, force: true });
  }
};

if (import.meta.main) {
  try {
    process.exitCode = await run();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
