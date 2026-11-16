// Why: a build that offers `neuve doctor` refuses to review a clone never set up, and an older
// build's setup writes a folder into the clone's working tree. So the runner sets a clone up exactly
// when `doctor --help` exits 0, and a failed setup stops it with the exit code alone, never the
// command's output. Setup run from source would record Bun as Neuve and find no Graph engine beside
// it, so the runner hands it the snapshot's own executable and the engine, each flag only where
// setup lists it. The snapshot's CLI is a stand-in that records its arguments: no engine, no network.
import { afterAll, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setUp } from "../src/harness-compare/runner.ts";

const dir = mkdtempSync(join(tmpdir(), "harness-compare-setup-"));
const engine = join(dir, "engine", "entire-graph");
const saved = {
  scratch: process.env["HARNESS_COMPARE_SCRATCH"],
  engine: process.env["NEUVE_GRAPH_BINARY"],
};
process.env["HARNESS_COMPARE_SCRATCH"] = dir;
process.env["NEUVE_GRAPH_BINARY"] = engine;
const restore = (name: string, value: string | undefined) => {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
};
afterAll(() => {
  restore("HARNESS_COMPARE_SCRATCH", saved.scratch);
  restore("NEUVE_GRAPH_BINARY", saved.engine);
  rmSync(dir, { recursive: true, force: true });
});

const standIn = (
  name: string,
  doctorExit: number,
  setupHelp: string,
  setupExit: number,
) => {
  const snap = join(dir, name);
  const calls = join(snap, "calls.jsonl");
  mkdirSync(join(snap, "apps/neuve-cli/src"), { recursive: true });
  writeFileSync(
    join(snap, "apps/neuve-cli/src/cli.ts"),
    `import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ args, engine: process.env.NEUVE_GRAPH_BINARY }) + "\\n");
if (args[0] === "--version") {
  console.log("neuve 0.0.0");
  process.exit(0);
}
if (args[0] === "doctor") process.exit(${doctorExit});
if (args[0] === "setup" && args[1] === "--help") {
  console.log(${JSON.stringify(setupHelp)});
  process.exit(0);
}
if (args[0] === "setup") {
  console.log("setup output the runner must not repeat");
  process.exit(${setupExit});
}
process.exit(9);
`,
  );
  const read = () =>
    existsSync(calls)
      ? readFileSync(calls, "utf8")
          .trim()
          .split("\n")
          .map(
            (line) =>
              JSON.parse(line) as {
                args: Array<string>;
                engine: string | undefined;
              },
          )
      : [];
  const args = () => read().map((call) => call.args);
  return { snap, read, args };
};

test("a clone is set up exactly when doctor --help exits 0", async () => {
  const home = join(dir, "home");
  const clone = join(dir, "a clone");
  const help =
    "Usage: neuve setup [--repo <path>] [--graph-binary <path>] [--cli-binary <path>] [--no-skills]";

  const current = standIn("doctor", 0, help, 0);
  expect(await setUp(current.snap, clone, home)).toBe(true);
  const wrapper = join(current.snap, "bin", "neuve");
  expect(current.args()).toEqual([
    ["doctor", "--help"],
    ["setup", "--help"],
    [
      "setup",
      "--repo",
      clone,
      "--cli-binary",
      wrapper,
      "--graph-binary",
      engine,
      "--no-skills",
    ],
  ]);
  expect(current.read().at(-1)?.engine).toBe(engine);
  // The executable handed to setup is the snapshot's CLI: it answers --version as Neuve.
  const version = Bun.spawnSync([wrapper, "--version"]);
  expect(version.exitCode).toBe(0);
  expect(version.stdout.toString()).toBe("neuve 0.0.0\n");
  expect(current.args().at(-1)).toEqual(["--version"]);

  const older = standIn("older", 1, "", 0);
  expect(await setUp(older.snap, clone, home)).toBe(false);
  expect(older.args()).toEqual([["doctor", "--help"]]);

  const failing = standIn(
    "failing",
    0,
    "Usage: neuve setup [--repo <path>]",
    3,
  );
  const error = await setUp(failing.snap, clone, home).then(
    () => undefined,
    (cause: unknown) => cause as Error,
  );
  expect(error?.message).toBe("neuve setup exited 3");
  // Flags setup does not list are left out; the engine still reaches it through the environment.
  expect(failing.args()).toEqual([
    ["doctor", "--help"],
    ["setup", "--help"],
    ["setup", "--repo", clone],
  ]);
  expect(failing.read().at(-1)?.engine).toBe(engine);
});
