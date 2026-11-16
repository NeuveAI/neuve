import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { graphTestArguments } from "./graph-dependent-tests.ts";

const graphPath = "apps/neuve-graph";
const initialize =
  "git submodule update --init --recursive -- apps/neuve-graph";

const git = (cwd: string, ...args: string[]) => {
  const result = Bun.spawnSync(
    ["git", "-c", "core.fsmonitor=false", "-C", cwd, ...args],
    {
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  if (result.exitCode !== 0)
    throw new Error(
      `Graph source check failed: ${result.stderr.toString().trim()}`,
    );
  return result.stdout.toString().trim();
};

export const checkGraphSource = (cwd: string) => {
  const graph = join(cwd, graphPath);
  if (
    !existsSync(join(graph, ".git")) ||
    !existsSync(join(graph, "go.mod")) ||
    !existsSync(join(graph, "cmd/entire-graph"))
  )
    throw new Error(
      `Graph source is absent or uninitialized. Run \`${initialize}\`.`,
    );
  const entry = git(cwd, "ls-tree", "HEAD", "--", graphPath);
  const expected = /^160000 commit ([0-9a-f]{40})\tapps\/neuve-graph$/.exec(
    entry,
  )?.[1];
  if (expected === undefined)
    throw new Error(
      `HEAD has no Graph gitlink at ${graphPath}. Check out a commit that includes the Graph submodule.`,
    );
  const actual = git(graph, "rev-parse", "HEAD");
  if (actual !== expected)
    throw new Error(
      `Graph submodule HEAD ${actual} does not match HEAD's gitlink ${expected}. Run \`${initialize}\`.`,
    );
  if (git(graph, "status", "--porcelain=v1", "--untracked-files=all"))
    throw new Error(
      `Graph submodule has local changes. Save or remove those changes in ${graphPath}, then run \`${initialize}\`.`,
    );
  if (Bun.which("go") === null)
    throw new Error(
      "Go is missing from PATH. Install the Go toolchain required by apps/neuve-graph/go.mod and add go to PATH, then rerun the check.",
    );
};

export const buildCheckedGraph = async (cwd: string) => {
  checkGraphSource(cwd);
  const build = Bun.spawn(
    [process.execPath, "--no-env-file", "run", "build:graph"],
    {
      cwd,
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  const code = await build.exited;
  if (code !== 0)
    throw new Error(
      `Graph build failed (${code}). Fix \`bun run build:graph\`, then rerun the check.`,
    );
};

if (import.meta.main) {
  try {
    const args = Bun.argv.slice(2);
    if (args.length > 1 || (args.length === 1 && args[0] !== "--test"))
      throw new Error("Usage: bun scripts/check-graph.ts [--test]");
    const cwd = resolve(import.meta.dirname, "..");
    await buildCheckedGraph(cwd);
    if (args[0] === "--test") {
      const tests = Bun.spawn(
        [
          process.execPath,
          "--no-env-file",
          "scripts/test-budget.ts",
          ...graphTestArguments(),
        ],
        {
          cwd,
          env: { ...process.env, NEUVE_MODE: "check" },
          stdout: "inherit",
          stderr: "inherit",
        },
      );
      process.exitCode = await tests.exited;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
