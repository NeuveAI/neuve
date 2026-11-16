import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import {
  positiveInteger,
  runTestProcess,
  testLaunchOptions,
} from "./test-process.ts";
import {
  errorCountOf,
  failLineOf,
  finishRun,
  junitArgs,
  loadSampler,
  outerRunEnv,
  plainBunTestArgs,
  REPORT_ENV,
  RUN_DIRECTORY_ENV,
  type PackageRecord,
  writePoolRecord,
} from "./test-report.ts";

const rootManifest = z.object({ workspaces: z.array(z.string()) });
const packageManifest = z.object({
  name: z.string().optional(),
  scripts: z.object({ test: z.string().optional() }).optional(),
});
const hasReporter = (args: string[]) =>
  args.some((arg) => arg === "--reporter" || arg.startsWith("--reporter="));
const longestFirst = [
  "@neuve/harness",
  "@neuve/cli",
  "@ace/host",
  "@neuve/records-core",
  "@neuve/evaluation",
  "@neuve/graph-client",
  "@workspace/diffs",
];

export const testWorkspaces = async (root: string) => {
  const manifest = rootManifest.parse(
    await Bun.file(join(root, "package.json")).json(),
  );
  const paths = new Set<string>();
  for (const pattern of manifest.workspaces) {
    for await (const path of new Bun.Glob(
      `${pattern.replace(/\/$/, "")}/package.json`,
    ).scan({ cwd: root, absolute: true }))
      paths.add(path);
  }
  const packages: {
    name: string;
    cwd: string;
    test: string;
    weight: number;
    mode: PackageRecord["mode"];
    args: string[] | null;
  }[] = [];
  for (const path of paths) {
    const pkg = packageManifest.parse(await Bun.file(path).json());
    const name = pkg.name;
    if (
      !name ||
      !pkg.scripts?.test ||
      name === "@neuve/graph" ||
      !(
        name.startsWith("@neuve/") ||
        name.startsWith("@workspace/") ||
        name.startsWith("@ace/") ||
        name === "web"
      )
    )
      continue;
    packages.push({
      name,
      cwd: dirname(path),
      test: pkg.scripts.test,
      weight: testLaunchOptions(
        pkg.scripts.test
          .split(/\s+/)
          .filter((arg) => arg === "--shards" || arg.startsWith("--shards=")),
      ).shards,
      mode: pkg.scripts.test.includes("scripts/test-budget.ts")
        ? "launcher"
        : plainBunTestArgs(pkg.scripts.test)
          ? "bun-test"
          : "other",
      args: plainBunTestArgs(pkg.scripts.test) ?? null,
    });
  }
  packages.sort((a, b) => {
    const rank = (name: string) => {
      const index = longestFirst.indexOf(name);
      return index === -1 ? longestFirst.length : index;
    };
    return rank(a.name) - rank(b.name) || a.name.localeCompare(b.name);
  });
  return packages;
};

const run = async () => {
  const only = new Set<string>();
  let list = false;
  for (const arg of Bun.argv.slice(2)) {
    if (arg === "--list") list = true;
    else if (arg.startsWith("--only=") && arg.length > "--only=".length)
      only.add(arg.slice("--only=".length));
    else
      throw new Error(
        "Usage: bun scripts/test-workspaces.ts [--list] [--only=<name> ...]",
      );
  }
  const capacity = positiveInteger(
    process.env.NEUVE_TEST_JOBS ?? "6",
    "NEUVE_TEST_JOBS",
  );
  const packages = await testWorkspaces(process.cwd());
  for (const name of only)
    if (!packages.some((pkg) => pkg.name === name))
      throw new Error(`No selected test workspace named ${name}`);
  const pending = packages.filter(
    (pkg) => only.size === 0 || only.has(pkg.name),
  );
  console.log(
    `[test-workspaces] Selected ${pending.length} packages, capacity ${capacity} slots:`,
  );
  for (const pkg of pending) console.log(`${pkg.name} (${pkg.weight} slots)`);
  if (pending.length === 0) throw new Error("No workspace test packages found");
  if (list) return 0;

  const directory = mkdtempSync(join(tmpdir(), "neuve-test-workspaces-"));
  // Under the root runner the run directory is the runner's and it reruns and reports; alone, the pool does.
  const inherited = process.env[RUN_DIRECTORY_ENV];
  const runDirectory = inherited ?? join(directory, "run");
  mkdirSync(runDirectory, { recursive: true });
  const report = process.env[REPORT_ENV];
  const sampler = inherited ? undefined : loadSampler();
  const running = new Set<Promise<void>>();
  const results: { name: string; code: number; seconds: string }[] = [];
  const records: PackageRecord[] = [];
  let used = 0;
  let stopped = 0;
  const interrupt = () => {
    stopped = 130;
  };
  const terminate = () => {
    stopped = 143;
  };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  try {
    while ((!stopped && pending.length > 0) || running.size > 0) {
      const index = stopped
        ? -1
        : pending.findIndex(
            (pkg) => running.size === 0 || used + pkg.weight <= capacity,
          );
      if (index === -1) {
        await Promise.race(running);
        continue;
      }
      const [pkg] = pending.splice(index, 1);
      if (!pkg) continue;
      used += pkg.weight;
      const budget = mkdtempSync(join(directory, "package-"));
      const started = performance.now();
      const record: PackageRecord = {
        name: pkg.name,
        cwd: pkg.cwd,
        mode: pkg.mode,
        args: pkg.args,
        code: 1,
        startedAt: Date.now(),
        endedAt: Date.now(),
        junit:
          pkg.mode === "bun-test" && pkg.args && !hasReporter(pkg.args)
            ? join(runDirectory, `junit-${records.length}.xml`)
            : null,
        fails: [],
        errors: 0,
      };
      records.push(record);
      const task = (async () => {
        let code = 1;
        try {
          code = await runTestProcess(
            [
              process.execPath,
              join(import.meta.dir, "test-guard.ts"),
              process.execPath,
              "run",
              "test",
              // A plain bun test (no launcher) names its failures in JUnit through extra script arguments.
              ...(record.junit ? junitArgs(record.junit) : []),
            ],
            {
              directory: budget,
              cwd: pkg.cwd,
              // Give nested launchers time to stop their detached test groups first.
              stopGraceMs: 5000,
              // Only the launcher reads the run directory; it hides it from the tests it starts.
              env:
                pkg.mode === "launcher"
                  ? { ...outerRunEnv, [RUN_DIRECTORY_ENV]: runDirectory }
                  : outerRunEnv,
              onLine: (line) => {
                const fail = failLineOf(line);
                if (fail) record.fails.push(fail);
                record.errors = errorCountOf(line) ?? record.errors;
                console.log(`${pkg.name}:test | ${line}`);
              },
            },
          );
        } catch (error) {
          console.error(
            `${pkg.name}:test | ${error instanceof Error ? error.message : String(error)}`,
          );
        } finally {
          rmSync(budget, { recursive: true, force: true });
          record.code = code;
          record.endedAt = Date.now();
          results.push({
            name: pkg.name,
            code,
            seconds: ((performance.now() - started) / 1000).toFixed(2),
          });
          used -= pkg.weight;
        }
      })();
      running.add(task);
      void task.then(() => running.delete(task));
    }
    console.log("\nPackage\tExit\tWall seconds");
    for (const pkg of packages) {
      const result = results.find(({ name }) => name === pkg.name);
      if (result)
        console.log(`${result.name}\t${result.code}\t${result.seconds}`);
    }
    const code = stopped || (results.some(({ code }) => code !== 0) ? 1 : 0);
    writePoolRecord(runDirectory, stopped, records);
    if (inherited) return code;
    return await finishRun({
      directory: runDirectory,
      samples: sampler?.samples ?? [],
      runCode: code,
      interrupted: stopped !== 0,
      stopped: () => stopped,
      ...(report ? { report } : {}),
    });
  } finally {
    sampler?.stop();
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
