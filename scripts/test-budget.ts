// Set the budget before Bun starts: its default child environment predates preloads.
import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runTestProcess,
  singleFileArgs,
  testLaunchOptions,
  watchLauncher,
  writeAll,
} from "./test-process.ts";

const writeStdout = (text: string) => writeAll(1, Buffer.from(text));

const launch = async () => {
  // Loaded only by the launcher itself, never by the preload in every test process.
  const { launchRecorder, RERUN_FILE_ENV } = await import("./test-report.ts");
  let options: ReturnType<typeof testLaunchOptions>;
  let timeoutMs: number | undefined;
  try {
    options = testLaunchOptions(Bun.argv.slice(2));
    // A rerun after the pool: the same flags, one file, no shards.
    const rerunFile = process.env[RERUN_FILE_ENV];
    if (rerunFile)
      options = {
        args: singleFileArgs(options.args, rerunFile),
        shards: 1,
        timings: undefined,
      };
    const configured = process.env.NEUVE_TEST_SUITE_TIMEOUT_MS;
    timeoutMs = configured === undefined ? undefined : Number(configured);
    if (
      timeoutMs !== undefined &&
      (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
    )
      throw new Error("NEUVE_TEST_SUITE_TIMEOUT_MS must be a positive integer");
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
  const directory = mkdtempSync(join(tmpdir(), "neuve-test-budget-"));
  try {
    const args = [...options.args];
    if (options.timings !== undefined) {
      if (existsSync(options.timings))
        args.push(`--timings=${options.timings}`);
      else
        console.error(
          `[test-budget] Timings file ${options.timings} is absent; running without shard timings.`,
        );
    }
    // Keep runtime flags such as --no-env-file for the test process.
    const command = [process.execPath, ...process.execArgv, "test", ...args];
    const timeout = timeoutMs === undefined ? {} : { timeoutMs };
    const recorder = launchRecorder(options.args);
    const run = (
      shard: string | null,
      shardCommand: string[],
      input: Parameters<typeof runTestProcess>[1],
    ) =>
      recorder
        ? recorder.run(shard, shardCommand, input)
        : runTestProcess(shardCommand, input);
    if (options.shards === 1)
      return await run(null, command, { directory, ...timeout });

    let printingFailed = false;
    const print = (text: string) => {
      if (printingFailed) return;
      try {
        writeStdout(text);
      } catch (error) {
        printingFailed = true;
        console.error(
          `[test-budget] Output failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    };
    const settled = await Promise.allSettled(
      Array.from({ length: options.shards }, async (_, index) => {
        const shard = `${index + 1}/${options.shards}`;
        const budget = mkdtempSync(join(directory, `shard-${index + 1}-`));
        const path = join(directory, `shard-${index + 1}.log`);
        const outputFile = openSync(path, "w");
        const started = performance.now();
        let code: number;
        try {
          code = await run(shard, [...command, `--shard=${shard}`], {
            directory: budget,
            outputFile,
            ...timeout,
          });
        } catch (error) {
          code = 1;
          console.error(
            `[test-budget] Shard ${shard}: ${error instanceof Error ? error.message : String(error)}`,
          );
        } finally {
          closeSync(outputFile);
        }
        const seconds = ((performance.now() - started) / 1000).toFixed(2);
        const output = readFileSync(path, "utf8");
        print(
          `\n[test-budget] Shard ${shard}, exit ${code}, ${seconds}s\n${output}${output.endsWith("\n") ? "" : "\n"}`,
        );
        const plain = Bun.stripANSI(output);
        const ran = [
          ...plain.matchAll(/^Ran (\d+) tests? across (\d+) files?[^\r\n]*/gm),
        ].at(-1);
        const count = (kind: string) =>
          Number(
            [
              ...plain.matchAll(new RegExp(`^[ \\t]*(\\d+) ${kind}\\b`, "gm")),
            ].at(-1)?.[1] ?? 0,
          );
        return {
          shard,
          code,
          seconds,
          ran,
          pass: count("pass"),
          fail: count("fail"),
        };
      }),
    );
    const results = settled.flatMap((result) => {
      if (result.status === "fulfilled") return [result.value];
      console.error(`[test-budget] Shard failed: ${String(result.reason)}`);
      return [];
    });
    print("\n[test-budget] Shard summary\n");
    let tests = 0,
      files = 0,
      pass = 0,
      fail = 0;
    for (const result of results) {
      print(
        `Shard ${result.shard}: exit ${result.code}, ${result.seconds}s | ${result.ran?.[0] ?? "missing Ran tests/files summary"}\n`,
      );
      tests += Number(result.ran?.[1] ?? 0);
      files += Number(result.ran?.[2] ?? 0);
      pass += result.pass;
      fail += result.fail;
    }
    print(
      `Totals: ${tests} tests, ${files} files, ${pass} pass, ${fail} fail\n`,
    );
    return (
      results.find(({ code }) => code !== 0)?.code ??
      (printingFailed ||
      results.length !== options.shards ||
      results.some(({ ran }) => ran === undefined)
        ? 1
        : 0)
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

if (import.meta.main) {
  process.exitCode = await launch();
} else {
  if (process.env.NEUVE_TEST_PROCESS !== "1")
    throw new Error(
      `Direct bun test requires the isolated launcher: run \`bun run test\`, or bun ${import.meta.path} <test arguments>`,
    );
  watchLauncher();
  if (!process.env.NEUVE_BUDGET_DIRECTORY) {
    const directory = mkdtempSync(join(tmpdir(), "neuve-test-budget-"));
    process.env.NEUVE_BUDGET_DIRECTORY = directory;
    process.on("exit", () =>
      rmSync(directory, { recursive: true, force: true }),
    );
  }
}
