import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Registry } from "@neuve/records-core";
import { markSetUp } from "./fixtures/set-up.ts";
import {
  CLI,
  removeScratch,
  scratch,
  temporary,
} from "./fixtures/setup-scratch.ts";

let binary: string;
beforeAll(async () => {
  const home = await temporary(tmpdir(), "neuve-capture-build-");
  binary = join(home, "neuve");
  const build = Bun.spawnSync(
    [
      process.execPath,
      "--no-env-file",
      join(import.meta.dir, "../scripts/build.ts"),
      "--outfile",
      binary,
    ],
    {
      env: {
        PATH: process.env.PATH,
        HOME: home,
        BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
      },
    },
  );
  expect(build.exitCode, build.stderr.toString()).toBe(0);
}, 30_000);
afterAll(removeScratch);

const fixture = async () => {
  const { root, repository, home, run, copy, git } = await scratch();
  await writeFile(
    join(root, "agent-stubs/claude"),
    "#!/bin/sh\necho '2.0.0 (Claude Code)'\n",
  );
  const hooks = {
    CLAUDE_CONFIG_DIR: join(home, "claude"),
    CODEX_HOME: join(home, "codex"),
    XDG_STATE_HOME: join(home, "state"),
  };
  const installed = (...args: string[]) => run([binary, ...args], hooks);
  const source = (...args: string[]) =>
    run([process.execPath, "--no-env-file", CLI, ...args], hooks);
  const setupHooks = (...args: string[]) =>
    installed("setup", "hooks", "--repo", repository, ...args);
  const upgrade = () => installed("setup", "upgrade", "--no-skills");
  const store = join(repository, ".git/neuve");
  const registry =
    process.platform === "darwin"
      ? Registry.registryPath(home)
      : join(hooks.XDG_STATE_HOME, "neuve/repositories.json");
  await mkdir(dirname(registry), { recursive: true });
  const list = async (...repositories: string[]) =>
    writeFile(
      registry,
      JSON.stringify({
        version: 1,
        repositories: repositories.map((path) => ({
          repository: path,
          store: join(path, ".git/neuve"),
        })),
      }),
    );
  await list(repository);
  return {
    root,
    repository,
    copy,
    git,
    installed,
    source,
    setupHooks,
    upgrade,
    list,
    config: join(store, "capture.json"),
    stack: join(store, "stack.json"),
    claude: join(hooks.CLAUDE_CONFIG_DIR, "settings.json"),
    codex: join(hooks.CODEX_HOME, "hooks.json"),
    gitHook: (name: string) => join(repository, ".git/hooks", name),
  };
};

// Capture repair needs setup to get past its Graph check, which uses provider identity alone
// for repositories with alternates.
const graphFor = async (root: string, repository: string) => {
  const alternate = join(root, "objects");
  await mkdir(alternate);
  await writeFile(
    join(repository, ".git/objects/info/alternates"),
    `${alternate}\n`,
  );
  const engine = join(root, "neuve-graph");
  const version = {
    provider: "entire-graph",
    version: "fixture",
    identity_revision: "fixture",
  };
  const capabilities = {
    provider: "entire-graph",
    schema_version: "1.3",
    supported_file_extensions: [],
    supported_languages: [],
    semantic_languages: [],
    inventory_only_languages: [],
    supported_relation_types: [],
    relation_support_by_language: {},
    relation_support_by_profile: {},
    heuristic_relation_types: [],
    parser_versions: {},
    unsupported_but_detected_language_hints: [],
    optional_local_only_features: {},
    features_requiring_network_access: {},
  };
  await writeFile(
    engine,
    `#!/bin/sh
case "$1" in
  version) echo '${JSON.stringify(version)}';;
  capabilities) echo '${JSON.stringify(capabilities)}';;
  *) exit 1;;
esac
`,
    { mode: 0o700 },
  );
  return engine;
};

// Exercise the released commands because source and compiled runs deliberately differ.
// Read back the files to catch lost capture choices, foreign entries, or no-op writes.
test("upgrade repairs dead hooks with backups, and healthy setup and upgrade leave capture untouched", async () => {
  const f = await fixture();
  const engine = await graphFor(f.root, f.repository);
  await markSetUp(f.repository, { cliBinary: f.copy, graphBinary: engine });
  const other = await scratch();
  await markSetUp(other.repository);
  await f.list(f.repository, other.repository);
  const foreign = {
    matcher: "other",
    hooks: [{ type: "command", command: "echo mine" }],
  };
  for (const path of [f.claude, f.codex]) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify({ hooks: { Stop: [foreign] } }));
  }
  const enabled = await f.setupHooks(
    "--agents",
    "codex,claude-code",
    "--session-trailer",
    "--command",
    f.copy,
    "--no-stack",
  );
  expect(enabled.code, enabled.stderr).toBe(0);
  const before = await Promise.all(
    [f.claude, f.codex].map((path) => readFile(path, "utf8")),
  );
  const hooks = ["prepare-commit-msg", "post-rewrite", "post-commit"];
  const original = JSON.parse(await readFile(f.config, "utf8"));
  await writeFile(f.config, JSON.stringify({ ...original, gitHooks: hooks }));
  const stack = await readFile(f.stack, "utf8");
  const past = new Date("2020-01-01T00:00:00Z");
  await utimes(f.stack, past, past);
  await rm(f.copy);

  const fromSource = await f.source("setup", "upgrade", "--no-skills");
  expect(fromSource.code, fromSource.stderr).toBe(0);
  expect(await readFile(f.claude, "utf8")).toBe(before[0]);
  const originalGitHook = await readFile(f.gitHook("post-commit"), "utf8");
  await writeFile(f.claude, "not JSON");
  const refused = await f.upgrade();
  expect(refused.code, refused.stderr).toBe(1);
  expect(refused.stdout).toContain(
    `${f.claude} can't be read as claude-code's hook file`,
  );
  expect(await readFile(f.claude, "utf8")).toBe("not JSON");
  expect(await readFile(f.codex, "utf8")).toBe(before[1]);
  expect(await readFile(f.gitHook("post-commit"), "utf8")).toBe(
    originalGitHook,
  );
  expect(JSON.parse(await readFile(f.config, "utf8")).hookCommand).toEqual([
    f.copy,
    "hook",
  ]);
  await writeFile(f.claude, before[0]!);

  const repaired = await f.upgrade();
  expect(repaired.code, repaired.stderr).toBe(0);
  expect(repaired.stdout).toContain("repaired");
  expect(JSON.parse(await readFile(f.config, "utf8"))).toEqual({
    version: 1,
    command: [binary],
    hookCommand: [binary, "hook"],
    gitHooks: hooks,
    agents: ["codex", "claude-code"],
    sessionTrailer: true,
  });
  for (const name of hooks)
    expect(await readFile(f.gitHook(name), "utf8")).toContain(
      `${binary} hook git ${name}`,
    );
  for (const [index, path] of [f.claude, f.codex].entries()) {
    const settings = await readFile(path, "utf8");
    expect(JSON.parse(settings).hooks.Stop[0]).toEqual(foreign);
    expect(settings).toContain(`${binary} hook`);
    expect(settings).not.toContain(f.copy);
    const backups = (await readdir(dirname(path))).filter((name) =>
      name.includes(".neuve-backup-"),
    );
    expect(
      await Promise.all(
        backups.map((name) => readFile(join(dirname(path), name), "utf8")),
      ),
    ).toContain(before[index]);
  }
  expect(await readFile(f.stack, "utf8")).toBe(stack);
  expect((await stat(f.stack)).mtimeMs).toBe(past.getTime());
  expect(
    await Bun.file(join(other.repository, ".git/neuve/capture.json")).exists(),
  ).toBe(false);

  const files = [f.config, f.stack, f.claude, f.codex, ...hooks.map(f.gitHook)];
  await Promise.all(files.map((path) => utimes(path, past, past)));
  const setup = await f.installed(
    "setup",
    "--repo",
    f.repository,
    "--agents",
    "none",
    "--no-skills",
  );
  const upgrade = await f.upgrade();
  for (const result of [setup, upgrade]) {
    expect(result.code, result.stderr).toBe(0);
    expect(
      result.stdout
        .split("\n")
        .filter(
          (line) => line.includes("nothing to do") && line.includes("Capture"),
        ),
    ).toHaveLength(1);
  }
  expect(
    await Promise.all(files.map(async (path) => (await stat(path)).mtimeMs)),
  ).toEqual(files.map(() => past.getTime()));
}, 90_000);

test("only the compiled CLI flags capture that calls a different working install", async () => {
  const f = await fixture();
  const engine = await graphFor(f.root, f.repository);
  await markSetUp(f.repository, { cliBinary: binary, graphBinary: engine });
  const enabled = await f.setupHooks(
    "--agents",
    "claude-code",
    "--command",
    f.copy,
    "--no-stack",
  );
  expect(enabled.code, enabled.stderr).toBe(0);
  expect(
    (
      await f.source(
        "setup",
        "--repo",
        f.repository,
        "--cli-binary",
        f.copy,
        "--agents",
        "none",
        "--no-skills",
      )
    ).code,
  ).toBe(0);
  expect(await readFile(f.claude, "utf8")).toContain(`${f.copy} hook`);

  const captureCheck = async (run: typeof f.installed) => {
    const result = await run("doctor", "--repo", f.repository, "--json");
    return JSON.parse(result.stdout).checks.find(
      (check: { check: string }) => check.check === "capture",
    );
  };
  expect(await captureCheck(f.source)).toMatchObject({ status: "ok" });
  const stale = await captureCheck(f.installed);
  expect(stale.status).toBe("warning");
  expect(stale.detail).toContain(`${f.claude} needs an update`);
  expect(stale.detail).toContain(`${f.config} needs an update`);
  expect(stale.detail).toContain("different Neuve install");
  expect(stale.fix).toContain("neuve setup hooks --repo");
  const setup = await f.installed(
    "setup",
    "--repo",
    f.repository,
    "--agents",
    "none",
    "--no-skills",
  );
  expect(setup.code, setup.stderr).toBe(0);
  expect(setup.stdout).toContain("repaired");
  expect(JSON.parse(await readFile(f.config, "utf8")).hookCommand).toEqual([
    binary,
    "hook",
  ]);
  expect(await readFile(f.claude, "utf8")).toContain(`${binary} hook`);
}, 60_000);
