// Scratch repositories for tests that run the real `neuve setup` from source, which needs the
// built Graph engine for its first index.
import { constants, existsSync, statSync } from "node:fs";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { graphTestPrerequisite } from "../../../../scripts/graph-test-prerequisite.ts";

export const CHECKOUT = resolve(import.meta.dir, "../../../..");
export const CLI = resolve(import.meta.dir, "../../src/cli.ts");
export const ENGINE = resolve(
  import.meta.dir,
  "../../../neuve-graph/entire-graph",
);
export const prerequisite = graphTestPrerequisite({
  available: existsSync(ENGINE),
  message: `The Graph engine is not built at ${ENGINE}. Run bun run build:graph.`,
});

const directories: string[] = [];
/** Removes every folder these helpers made; each test file calls it from afterAll. */
export const removeScratch = async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
};
export const temporary = async (parent: string, name: string) => {
  await mkdir(parent, { recursive: true });
  const directory = await realpath(await mkdtemp(join(parent, name)));
  directories.push(directory);
  return directory;
};

export const scratch = async (parent = tmpdir()) => {
  const root = await temporary(parent, "neuve-setup-");
  const repository = join(root, "repo");
  const home = join(root, "home");
  await mkdir(home);
  await mkdir(repository);
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", "-C", repository, ...args], {
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
    });
    return result.stdout.toString().trim();
  };
  const commit = async (file: string, text: string) => {
    await writeFile(join(repository, file), text);
    git("add", file);
    git(
      "-c",
      "user.name=T",
      "-c",
      "user.email=t@example.invalid",
      "commit",
      "-qm",
      file,
    );
  };
  git("init", "-q");
  await commit("a.ts", "export const a = 1;\n");
  const stubs = join(root, "agent-stubs");
  await mkdir(stubs);
  for (const name of ["claude", "codex"]) {
    await writeFile(join(stubs, name), "#!/bin/sh\nexit 1\n");
    await chmod(join(stubs, name), 0o755);
  }
  // From source, setup records the neuve it is told; this one only has to answer.
  const copy = join(root, "neuve");
  await writeFile(copy, "#!/bin/sh\necho 'neuve 0.1.0'\n");
  await chmod(copy, 0o755);
  const env = (extra: Record<string, string> = {}) => ({
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    // Stand-ins first, so doctor run here never starts this machine's Claude Code or Codex.
    PATH: `${stubs}${delimiter}${process.env["PATH"] ?? ""}`,
    TMPDIR: root,
    NEUVE_TEST_PROCESS: "1",
    NEUVE_BUDGET_DIRECTORY: join(root, "budget"),
    GIT_CONFIG_GLOBAL: "/dev/null",
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
    ...extra,
  });
  const run = async (command: string[], extra: Record<string, string> = {}) => {
    const child = Bun.spawn(command, {
      cwd: home,
      env: env(extra),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { stdout, stderr, code };
  };
  const setup = (engine = ENGINE, extra: Record<string, string> = {}) =>
    run(
      [
        process.execPath,
        "--no-env-file",
        CLI,
        "setup",
        "--repo",
        repository,
        "--cli-binary",
        copy,
        "--graph-binary",
        engine,
        // These tests are about setup itself; the agent programs have their own.
        "--agents",
        "none",
        // The record on standard output, the lines on standard error.
        "--json",
      ],
      extra,
    );
  return { root, repository, home, git, commit, copy, run, setup };
};

/** A folder on another volume than `path`, if this machine has one to offer. */
export const otherVolume = async (path: string) => {
  const device = statSync(path).dev;
  for (const candidate of [dirname(ENGINE), "/tmp/claude", tmpdir()]) {
    try {
      await mkdir(candidate, { recursive: true });
      if (statSync(candidate).dev !== device) return candidate;
    } catch {
      // Not writable here.
    }
  }
  return undefined;
};

/** A copy of the engine under `parent`, cloned where the file system can. */
export const engineIn = async (parent: string) => {
  const directory = await temporary(parent, "neuve-engine-");
  const copy = join(directory, "entire-graph");
  await copyFile(ENGINE, copy, constants.COPYFILE_FICLONE);
  await chmod(copy, 0o755);
  return copy;
};

/** `neuve query`'s public result for `repository`, as an earlier setup wrote `initial-index.json`. */
export const observation = (repository: string, revision: string) => ({
  schema_version: 2,
  provider: {
    name: "entire-graph",
    version: "dev",
    identity_revision: "8",
    capabilities: {},
  },
  query: "repository",
  source: { repository, revision },
  retrieval: { status: "ok", candidates: [] },
  structural_observations: [],
});

/**
 * The `neuve/` folder an earlier setup left in the working tree: its schema 3 record, its two links
 * and its index (or `index` in place of the observation).
 */
export const legacyFolder = async (
  repository: string,
  cli: string,
  revision: string,
  index: unknown = observation(repository, revision),
) => {
  const folder = join(repository, "neuve");
  await mkdir(join(folder, "bin"), { recursive: true });
  await symlink(cli, join(folder, "bin/neuve"));
  await symlink(ENGINE, join(folder, "bin/neuve-graph"));
  await writeFile(join(folder, "initial-index.json"), JSON.stringify(index));
  await writeFile(
    join(folder, "config.json"),
    JSON.stringify({
      schemaVersion: 3,
      repository,
      cliBinary: join(folder, "bin/neuve"),
      graphBinary: join(folder, "bin/neuve-graph"),
    }),
  );
  return folder;
};
