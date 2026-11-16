import { writeSync } from "node:fs";
import { basename } from "node:path";
import { dlopen } from "bun:ffi";

const writeRetry = new Int32Array(new SharedArrayBuffer(4));
/** Write every byte to a descriptor, waiting out a non-blocking pipe's EAGAIN. */
export const writeAll = (fd: number, bytes: Uint8Array) => {
  let offset = 0;
  while (offset < bytes.length) {
    try {
      offset += writeSync(fd, bytes, offset, bytes.length - offset);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "EAGAIN")
        Atomics.wait(writeRetry, 0, 0, 5);
      else throw error;
    }
  }
};

export const watchLauncher = () => {
  const configured = process.env.NEUVE_TEST_LAUNCHER_PID;
  if (configured === undefined) return;
  const launcherPid = Number(configured);
  if (!Number.isSafeInteger(launcherPid) || launcherPid <= 0)
    throw new Error("NEUVE_TEST_LAUNCHER_PID must be a positive integer");
  let orphaned = false;
  if (process.ppid !== launcherPid) {
    orphaned = process.ppid === 1;
    if (!orphaned) {
      try {
        process.kill(launcherPid, 0);
      } catch (error) {
        // EPERM still means alive; only ESRCH identifies a dead launcher.
        orphaned =
          error instanceof Error && "code" in error && error.code === "ESRCH";
      }
    }
    if (!orphaned) return;
  }
  const libc = dlopen(
    process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6",
    { getpgrp: { args: [], returns: "i32" } },
  );
  // Descendants inherit the marker and may load this preload too. Only the
  // detached group leader can own a group kill.
  if (libc.symbols.getpgrp() !== process.pid) {
    libc.close();
    return;
  }
  if (orphaned) {
    libc.close();
    process.kill(-process.pid, "SIGKILL");
    return;
  }
  const timer = setInterval(() => {
    let gone = process.ppid !== launcherPid;
    if (!gone) {
      try {
        process.kill(launcherPid, 0);
      } catch (error) {
        // EPERM means it exists but cannot be signalled in this sandbox.
        gone =
          error instanceof Error && "code" in error && error.code === "ESRCH";
      }
    }
    if (gone && libc.symbols.getpgrp() === process.pid)
      process.kill(-process.pid, "SIGKILL");
  }, 1000);
  timer.unref();
  process.on("exit", () => {
    clearInterval(timer);
    libc.close();
  });
};

/** Own the test process group, including descendants that retain the check's output pipes. */
export async function runTestProcess(
  command: string[],
  input: {
    directory: string;
    timeoutMs?: number;
    stopGraceMs?: number;
    cwd?: string;
    outputFile?: number;
    onLine?: (line: string) => void;
    /** Forward the output unchanged (to outputFile, else this process's stdout/stderr) and report each line as it arrives. */
    tee?: (line: string) => void;
    env?: Record<string, string | undefined>;
  },
): Promise<number> {
  const piped = input.onLine !== undefined || input.tee !== undefined;
  const child = Bun.spawn(command, {
    detached: true,
    ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
    env: {
      ...process.env,
      ...input.env,
      NEUVE_TEST_PROCESS: "1",
      NEUVE_TEST_LAUNCHER_PID: String(process.pid),
      NEUVE_BUDGET_DIRECTORY: input.directory,
    },
    stdin: "inherit",
    stdout: piped ? "pipe" : (input.outputFile ?? "inherit"),
    stderr: piped ? "pipe" : (input.outputFile ?? "inherit"),
  });
  let forwardFailed = false;
  const readLines = async (
    stream: ReadableStream<Uint8Array> | number | null | undefined,
    fd: number,
  ) => {
    if (!piped || stream == null || typeof stream === "number") return;
    const onLine = input.onLine ?? input.tee;
    let pending = "";
    const decoder = new TextDecoder();
    for await (const chunk of stream) {
      if (input.tee && !forwardFailed) {
        try {
          writeAll(input.outputFile ?? fd, chunk);
        } catch {
          // A closed reader must not block the test process; keep draining.
          forwardFailed = true;
        }
      }
      pending += decoder.decode(chunk, { stream: true });
      let newline: number;
      while ((newline = pending.indexOf("\n")) !== -1) {
        onLine?.(pending.slice(0, newline).replace(/\r$/, ""));
        pending = pending.slice(newline + 1);
      }
    }
    pending += decoder.decode();
    if (pending) onLine?.(pending);
  };
  const output = Promise.all([
    readLines(child.stdout, 1),
    readLines(child.stderr, 2),
  ]);
  const kill = (signal: NodeJS.Signals) => {
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      if (!(
        error instanceof Error &&
        "code" in error &&
        error.code === "ESRCH"
      ))
        throw error;
    }
  };
  let escalation: ReturnType<typeof setTimeout> | undefined;
  let signalExit: number | undefined;
  let stoppedAt: number | undefined;
  const stop = (signal: NodeJS.Signals) => {
    stoppedAt ??= performance.now();
    kill(signal);
    escalation ??= setTimeout(() => kill("SIGKILL"), input.stopGraceMs ?? 2000);
  };
  const interrupt = () => {
      signalExit = 130;
      stop("SIGINT");
    },
    terminate = () => {
      signalExit = 143;
      stop("SIGTERM");
    };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  let timedOut = false;
  const timeout =
    input.timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          timedOut = true;
          console.error(
            `[test-budget] Suite timed out after ${input.timeoutMs} ms waiting for ${basename(command[0] ?? "bun")} test PID ${child.pid}, process group ${child.pid}.`,
          );
          // Command names only. Arguments and environment can contain secrets.
          try {
            const listing = Bun.spawnSync(
              ["/bin/ps", "-axo", "pid=,ppid=,pgid=,comm="],
              { stdout: "pipe", stderr: "ignore", timeout: 500 },
            );
            if (listing.exitCode === 0) {
              for (const line of listing.stdout
                .toString()
                .split("\n")
                .filter(
                  (line) => line.trim().split(/\s+/)[2] === String(child.pid),
                )
                .slice(0, 20))
                console.error(`[test-budget] waiting process: ${line.trim()}`);
            } else throw new Error("Process listing unavailable");
          } catch {
            console.error(
              "[test-budget] Process listing unavailable; the PID and group above identify the wait.",
            );
          }
          stop("SIGTERM");
        }, input.timeoutMs);
  try {
    const code = await child.exited;
    return timedOut ? 124 : (signalExit ?? code);
  } finally {
    clearTimeout(timeout);
    if (stoppedAt !== undefined)
      await Bun.sleep(
        Math.max(
          0,
          (input.stopGraceMs ?? 2000) - (performance.now() - stoppedAt),
        ),
      );
    clearTimeout(escalation);
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", terminate);
    // A successful test process can leave a descendant holding stdout/stderr open.
    kill("SIGKILL");
    await output;
  }
}

export const positiveInteger = (value: string, name: string): number => {
  if (
    !/^\d+$/.test(value) ||
    !Number.isSafeInteger(Number(value)) ||
    Number(value) < 1
  )
    throw new Error(`${name} must be a positive integer`);
  return Number(value);
};

// Loaded checks need more than Bun's 5 s default; tests and callers keep their chosen limits.
const DEFAULT_TEST_TIMEOUT_MS = 30_000;

export const testLaunchOptions = (args: string[]) => {
  if (args.some((arg) => arg === "--parallel" || arg.startsWith("--parallel=")))
    throw new Error(
      "The launcher cannot watch a parallel coordinator because it never loads the preload. Run bun test --parallel --timeout=… directly.",
    );
  const testArgs: string[] = [];
  let shards: number | undefined;
  let timings: string | undefined;
  for (const arg of args) {
    if (arg === "--shards" || arg.startsWith("--shards=")) {
      if (shards !== undefined) throw new Error("Pass --shards only once");
      shards = positiveInteger(arg.slice("--shards=".length), "--shards");
    } else if (arg.startsWith("--shard-timings=")) {
      timings = arg.slice("--shard-timings=".length);
    } else testArgs.push(arg);
  }
  if (
    shards !== undefined &&
    testArgs.some((arg) => arg === "--shard" || arg.startsWith("--shard="))
  )
    throw new Error("--shards cannot be combined with --shard");
  if (shards !== undefined && process.env.NEUVE_TEST_SHARDS !== undefined)
    shards = positiveInteger(
      process.env.NEUVE_TEST_SHARDS,
      "NEUVE_TEST_SHARDS",
    );
  if ((shards ?? 1) > 1 && testArgs.includes("--update-timings"))
    throw new Error(
      "--update-timings cannot be combined with more than one shard",
    );
  if (
    !testArgs.some((arg) => arg === "--timeout" || arg.startsWith("--timeout="))
  )
    testArgs.push(`--timeout=${DEFAULT_TEST_TIMEOUT_MS}`);
  return { args: testArgs, shards: shards ?? 1, timings };
};

// Bun test flags whose value may follow as the next argument (Bun 1.4.4 `bun test --help` and the runtime flags).
const valueFlags = new Set([
  "--timeout",
  "--rerun-each",
  "--retry",
  "--seed",
  "--coverage-reporter",
  "--coverage-dir",
  "-t",
  "--test-name-pattern",
  "--reporter",
  "--reporter-outfile",
  "--max-concurrency",
  "--path-ignore-patterns",
  "--parallel-delay",
  "--shard",
  "--timings",
  "-r",
  "--preload",
  "--cwd",
  "-c",
  "--config",
  "--env-file",
  "--tsconfig-override",
  "-d",
  "--define",
  "-l",
  "--loader",
  "--conditions",
]);

/** The same test flags with every path filter replaced by one file, so a rerun runs that file alone. */
export const singleFileArgs = (args: string[], file: string) => {
  const kept: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] ?? "";
    if (!arg.startsWith("-")) continue;
    const value = valueFlags.has(arg) && index + 1 < args.length;
    // One file runs whole: no shard selection.
    if (arg === "--shard" || arg.startsWith("--shard=")) {
      if (value) index++;
      continue;
    }
    kept.push(arg);
    if (value) kept.push(args[++index] ?? "");
  }
  return [...kept, file];
};
