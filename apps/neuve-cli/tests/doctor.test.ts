// Why: `neuve doctor` is how a newcomer finds what a review still needs. Each check must name the
// exact fix, read only (no store, no worker, no file written), and never print a credential. It
// runs the CLI from source in its own process with a scratch home, so nothing of this machine's
// settings or sign-in is read.
import { afterAll, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { settingsPath } from "../../../packages/harness/src/settings.ts";
import { markSetUp } from "./fixtures/set-up.ts";

const CLI = resolve(import.meta.dir, "../src/cli.ts");

type Check = { check: string; status: string; detail: string; fix?: string };
type Report = { checks: Check[]; exitCode: number };

const directories: string[] = [];
afterAll(async () => {
  for (const directory of directories)
    await rm(directory, { recursive: true, force: true });
});

const scratch = async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "neuve-doctor-")));
  directories.push(root);
  const repository = join(root, "repo");
  const home = join(root, "home");
  await mkdir(home);
  await mkdir(repository);
  // Only the tools doctor runs, so no neuve installed on this machine is on its PATH.
  const tools = join(root, "tools");
  await mkdir(tools);
  for (const tool of ["git", "xcode-select"]) {
    const found = Bun.which(tool);
    if (found !== null) await symlink(found, join(tools, tool));
  }
  for (const args of [
    ["init", "-q"],
    [
      "-c",
      "user.name=T",
      "-c",
      "user.email=t@example.invalid",
      "commit",
      "--allow-empty",
      "-qm",
      "first",
    ],
  ])
    Bun.spawnSync(["git", "-C", repository, ...args]);
  const doctor = async (
    extra: Record<string, string> = {},
    args: string[] = [],
  ) => {
    const env: Record<string, string> = {
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      PATH: tools,
      TMPDIR: root,
      NEUVE_TEST_PROCESS: "1",
      NEUVE_BUDGET_DIRECTORY: join(root, "budget"),
      GIT_CONFIG_GLOBAL: "/dev/null",
      // Bun's own cache of transpiled source would otherwise land in the home.
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
      ...extra,
    };
    const child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        CLI,
        "doctor",
        "--repo",
        repository,
        "--json",
        ...args,
      ],
      { env, stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(stderr).toBe("");
    const report = JSON.parse(stdout) as Report;
    expect(report.exitCode).toBe(code);
    const check = (name: string) =>
      report.checks.find((entry) => entry.check === name);
    return { report, code, stdout, check };
  };
  return { root, repository, home, tools, doctor };
};

test("doctor names missing setup and sign-in with their fixes, exits 1 and writes nothing", async () => {
  const { repository, home, doctor } = await scratch();
  const before = (
    await readdir(join(repository, ".git"), { recursive: true })
  ).sort();
  const { code, check } = await doctor();
  expect(code).toBe(1);
  expect(check("setup")).toEqual({
    check: "setup",
    status: "missing",
    detail: `Neuve isn't set up in ${repository}`,
    fix: `neuve setup --repo '${repository}'`,
  });
  const settings = settingsPath(home);
  expect(check("sign-in")).toMatchObject({
    status: "missing",
    detail: `Reviews use the Anthropic route (the default; ${settings} names none), and ANTHROPIC_API_KEY isn't set in this shell. A review waits until a worker has it`,
  });
  expect(check("sign-in")?.fix).toContain(
    `then run neuve worker stop --repo '${repository}' && neuve worker start --repo '${repository}'`,
  );
  // The other way in is setup's route flag, not an edit of the settings file.
  expect(check("sign-in")?.fix).toContain(
    `Or sign in with ChatGPT instead: neuve setup --repo '${repository}' --route openai && neuve auth login openai && `,
  );
  expect(check("sign-in")?.fix).not.toContain(settings);
  expect(check("worker")).toEqual({
    check: "worker",
    status: "ok",
    detail:
      "No worker is running. neuve review starts one when this shell has the sign-in",
  });
  // Read-only: no store, no worker files, nothing in the repository or the home.
  expect(
    (await readdir(join(repository, ".git"), { recursive: true })).sort(),
  ).toEqual(before);
  expect(await readdir(repository)).toEqual([".git"]);
  expect(await readdir(home)).toEqual([]);
});

test("a key in the environment is named, never printed", async () => {
  const { repository, doctor } = await scratch();
  await markSetUp(repository);
  const secret = "sk-ant-doctor-test-value-never-printed";
  const { stdout, check } = await doctor({ ANTHROPIC_API_KEY: secret });
  expect(stdout).not.toContain(secret);
  expect(check("sign-in")).toMatchObject({
    status: "ok",
    detail: expect.stringContaining(
      "ANTHROPIC_API_KEY is available in this shell",
    ),
  });
});

// Why: capture's hooks discard their output and exit 0, so a hook calling a program that is gone
// stops capture without a word; and setup's steps are what an upgrade relies on. Doctor is where
// each shows, read only, in the words setup upgrade uses.
test("doctor names capture that isn't set up, a hook calling a program that is gone, and setup's steps", async () => {
  const { root, repository, home, doctor } = await scratch();
  await markSetUp(repository);
  const isolated = {
    CLAUDE_CONFIG_DIR: join(home, ".claude"),
    CODEX_HOME: join(home, ".codex"),
  };
  const first = await doctor(isolated);
  expect(first.check("capture")).toMatchObject({
    status: "warning",
    detail: expect.stringContaining("Capture isn't set up in"),
  });
  expect(first.check("setup steps")).toMatchObject({
    status: "warning",
    detail: expect.stringContaining(
      "Not applied yet: setup looks for the agent programs",
    ),
  });

  // Capture set up with an install that then moves away.
  const old = join(root, "old/bin/neuve");
  await mkdir(dirname(old), { recursive: true });
  await writeFile(old, "#!/bin/sh\nexit 0\n");
  await chmod(old, 0o755);
  const { runSetupHooks } = await import("../src/capture/setup-hooks.ts");
  expect(
    await runSetupHooks(
      [
        "--repo",
        repository,
        "--agents",
        "claude-code",
        "--claude-settings",
        join(home, ".claude/settings.json"),
        "--codex-hooks",
        join(home, ".codex/hooks.json"),
        "--command",
        old,
        "--no-stack",
      ],
      { stackStore: join(root, "stack") },
    ),
  ).toBe(0);
  expect((await doctor(isolated)).check("capture")?.status).toBe("ok");
  await rm(join(root, "old"), { recursive: true });
  expect((await doctor(isolated)).check("capture")).toMatchObject({
    status: "warning",
    detail: expect.stringContaining(
      `run ${old}, which isn't there or can't run`,
    ),
    fix: `neuve setup hooks --repo '${repository}'`,
  });

  // A skill offer considered for a reason is named, not "not applied yet".
  const stamp = { appliedAt: "2026-11-21T00:00:00.000Z", by: "0.2.1" };
  const machine = join(dirname(settingsPath(home)), "setup-steps.json");
  await mkdir(dirname(machine), { recursive: true });
  await writeFile(
    machine,
    JSON.stringify({
      schemaVersion: 1,
      steps: { "agent-programs": { ...stamp, outcome: "checked" } },
    }),
  );
  await writeFile(
    join(repository, ".git/neuve/setup/setup-steps.json"),
    JSON.stringify({
      schemaVersion: 1,
      steps: {
        "skill-offer": {
          ...stamp,
          outcome: "considered",
          reason: "no agent program was found to offer it to",
        },
      },
    }),
  );
  expect((await doctor(isolated)).check("setup steps")).toMatchObject({
    status: "ok",
    detail: expect.stringContaining(
      "not done, as no agent program was found to offer it to",
    ),
  });
});

// Why: the person's hook file can be in any shape; doctor must report one it can't read, with a fix
// that works, and setup hooks must stop on it in the same words rather than throw.
test("doctor reports an agent hook file it can't read in a repository with capture, and setup hooks stops on it", async () => {
  const { root, repository, home, doctor } = await scratch();
  await markSetUp(repository);
  const settings = join(home, ".claude/settings.json");
  const isolated = {
    CLAUDE_CONFIG_DIR: join(home, ".claude"),
    CODEX_HOME: join(home, ".codex"),
  };
  const program = join(root, "bin/neuve");
  await mkdir(dirname(program), { recursive: true });
  await writeFile(program, "#!/bin/sh\nexit 0\n");
  await chmod(program, 0o755);
  const { runSetupHooks } = await import("../src/capture/setup-hooks.ts");
  const setUp = () =>
    runSetupHooks(
      [
        "--repo",
        repository,
        "--agents",
        "claude-code",
        "--claude-settings",
        settings,
        "--codex-hooks",
        join(home, ".codex/hooks.json"),
        "--command",
        program,
        "--no-stack",
      ],
      { stackStore: join(root, "stack") },
    );
  expect(await setUp()).toBe(0);
  await writeFile(settings, '{"hooks":{"Stop":{}}}');
  const { check } = await doctor(isolated);
  // The same sentence in both places. Read before matching: a matcher can stand in for the value.
  const sentence = `${settings} can't be read as claude-code's hook file (hooks.Stop: Invalid input: expected array, received object), so Neuve leaves it as it is. Fix it or move it away, then run neuve setup hooks again.`;
  const detail = String(check("capture")?.detail);
  expect(detail.includes(sentence)).toBe(true);
  expect(check("capture")).toMatchObject({
    status: "warning",
    detail: expect.stringContaining(`${settings} can't be read`),
    fix: `Fix or move ${settings}, then run neuve setup hooks --repo '${repository}'`,
  });
  await expect(setUp()).rejects.toThrow(sentence);
  expect(await Bun.file(settings).text()).toBe('{"hooks":{"Stop":{}}}');
});

test("the OpenAI route in the settings needs its sign-in, and unreadable settings are named", async () => {
  const { home, doctor } = await scratch();
  const folder = dirname(settingsPath(home));
  await mkdir(folder, { recursive: true });
  await writeFile(
    join(folder, "settings.json"),
    JSON.stringify({ version: 1, review: { route: "openai" } }),
  );
  const openai = (await doctor()).check("sign-in");
  expect(openai?.status).toBe("missing");
  expect(openai?.detail).toStartWith(
    `Reviews use the OpenAI route (review.route in ${join(folder, "settings.json")}), and this machine isn't signed in to it`,
  );
  expect(openai?.fix).toStartWith(
    "neuve auth login openai && neuve worker stop --repo",
  );
  await writeFile(join(folder, "settings.json"), "{");
  expect((await doctor()).check("sign-in")).toEqual({
    check: "sign-in",
    status: "missing",
    detail: `Neuve can't read its settings at ${join(folder, "settings.json")}`,
    fix: `Correct or remove ${join(folder, "settings.json")}, then run neuve doctor`,
  });
});

// Why: doctor promises no network, and checking a Claude sign-in opens Claude Code, which can reach
// it. So on the Claude route doctor only looks for claude on PATH and names the command that checks
// the sign-in; the claude it finds must never run.
test("the Claude route names a missing Claude Code with its fix, and never opens one it finds", async () => {
  const { root, home, tools, doctor } = await scratch();
  const folder = dirname(settingsPath(home));
  await mkdir(folder, { recursive: true });
  const settings = join(folder, "settings.json");
  await writeFile(
    settings,
    JSON.stringify({ version: 1, review: { route: "claude" } }),
  );
  expect((await doctor()).check("sign-in")).toEqual({
    check: "sign-in",
    status: "missing",
    detail: `Reviews use your Claude subscription through Claude Code (review.route in ${settings}), and Claude Code isn't installed: there's no claude on PATH. A review waits until a worker has it`,
    fix: "install Claude Code, then run claude auth login && neuve auth status claude --check",
  });
  const ran = join(root, "claude-ran");
  const claude = join(tools, "claude");
  await writeFile(
    claude,
    `#!/bin/sh
touch '${ran}'
`,
  );
  await chmod(claude, 0o755);
  expect((await doctor()).check("sign-in")).toEqual({
    check: "sign-in",
    status: "ok",
    detail: `Reviews use your Claude subscription through Claude Code (review.route in ${settings}). Claude Code is at ${claude}. Doctor doesn't open it, so it doesn't check the sign-in: neuve auth status claude --check does, without spending usage`,
  });
  expect(await Bun.file(ran).exists()).toBe(false);
});

test("doctor names every neuve PATH could run, the release and the source install", async () => {
  const { root, home, tools, doctor } = await scratch();
  const copy = async (folder: string) => {
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "neuve"), "#!/bin/sh\n");
    await chmod(join(folder, "neuve"), 0o755);
  };
  await copy(join(home, ".neuve/bin"));
  await copy(join(home, ".local/bin"));
  const { check } = await doctor({
    PATH: `${join(home, ".local/bin")}:${tools}`,
  });
  expect(check("PATH")).toEqual({
    check: "PATH",
    status: "warning",
    detail: `neuve on PATH runs ${join(home, ".local/bin/neuve")} (the install from source). Another copy is also installed: ${join(home, ".neuve/bin/neuve")} (the release install). The first one on PATH wins`,
    fix: "Remove the copy you don't use, or put the one you want first on PATH",
  });
  // Nothing on PATH at all is missing.
  const bare = await doctor({ PATH: join(root, "empty") });
  expect(bare.check("PATH")?.status).toBe("missing");
});

// Why: on a Mac without the Xcode command-line tools, /usr/bin/git opens Apple's installer instead
// of running, so once Git isn't usable doctor, review and setup must not run it at all. With Git
// absent from PATH they say what's missing, run no Git, and create nothing.
test("with no usable Git, doctor, review and setup say so and leave the repository alone", async () => {
  const { root, repository, home, doctor } = await scratch();
  const noGit = join(root, "no-git");
  await mkdir(noGit);
  const select = Bun.which("xcode-select");
  if (select !== null) await symlink(select, join(noGit, "xcode-select"));
  const before = (
    await readdir(join(repository, ".git"), { recursive: true })
  ).sort();
  const { code, check, report } = await doctor({ PATH: noGit });
  expect(code).toBe(1);
  expect(check("Git")).toMatchObject({
    status: "missing",
    detail: "Git isn't on PATH",
  });
  expect(check("repository")).toEqual({
    check: "repository",
    status: "missing",
    detail: `Doctor can't look at ${repository} until Git works`,
    fix: "Fix Git first (above), then run neuve doctor again",
  });
  expect(report.checks.map((entry) => entry.check)).not.toContain("setup");
  expect(report.checks.map((entry) => entry.check)).not.toContain("worker");
  for (const args of [
    ["review", "HEAD~1..HEAD", "--detach", "--repo", repository],
    ["review", "show", "--repo", repository],
    ["setup", "--repo", repository],
  ]) {
    const child = Bun.spawn([process.execPath, "--no-env-file", CLI, ...args], {
      env: {
        HOME: home,
        PATH: noGit,
        TMPDIR: root,
        NEUVE_TEST_PROCESS: "1",
        NEUVE_BUDGET_DIRECTORY: join(root, "budget"),
        BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stderr, exit] = await Promise.all([
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect({ args, exit, stderr }).toEqual({
      args,
      exit: 1,
      stderr: `Neuve needs Git, and it isn't on PATH.\nTo fix it: ${process.platform === "darwin" ? "xcode-select --install" : "Install Git with your system's package manager"}\n`,
    });
  }
  expect(
    (await readdir(join(repository, ".git"), { recursive: true })).sort(),
  ).toEqual(before);
});

// Why: a person and an agent both type --help first; these printed an error instead.
test("setup --help, review show --help and stack list --help print their usage and exit 0", async () => {
  for (const args of [
    ["setup", "--help"],
    ["review", "show", "--help"],
    ["stack", "list", "--help"],
  ]) {
    const child = Bun.spawn([process.execPath, "--no-env-file", CLI, ...args], {
      env: { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect({ args, exit, stderr }).toEqual({ args, exit: 0, stderr: "" });
    expect(stdout).toContain(`neuve ${args.join(" ").replace(" --help", "")}`);
  }
});

// The diagnosis must describe this repository, rather than imposing a minimum on every Git.
for (const partialClone of [false, true]) {
  test(`doctor assesses old Git in a ${partialClone ? "partial" : "full"} clone`, async () => {
    const { repository, tools, doctor } = await scratch();
    if (partialClone) {
      const result = Bun.spawnSync([
        "git",
        "-C",
        repository,
        "config",
        "remote.origin.promisor",
        "true",
      ]);
      expect(result.exitCode).toBe(0);
    }
    const hostGit = Bun.which("git");
    if (hostGit === null) throw new Error("Git unavailable");
    await rm(join(tools, "git"));
    await writeFile(
      join(tools, "git"),
      `#!${process.execPath}
const args = process.argv.slice(2);
if (args.includes("--no-lazy-fetch")) process.exit(129);
if (args.at(-1) === "version" || args.at(-1) === "--version") { console.log("git version 2.39.5 (Apple Git-154)"); process.exit(0); }
const result = Bun.spawnSync([${JSON.stringify(hostGit)}, ...args], { env: process.env, stdout: "inherit", stderr: "inherit" });
process.exit(result.exitCode);
`,
    );
    await chmod(join(tools, "git"), 0o755);
    const { check } = await doctor();
    const offline = check("offline Git reads");
    expect(offline?.status).toBe(partialClone ? "missing" : "ok");
    expect(offline?.detail).toContain("git version 2.39.5 (Apple Git-154)");
    if (partialClone) {
      expect(offline?.detail).toContain("this repository is a partial clone");
      expect(offline?.fix).toBe(
        "Install Git 2.45 or later, for example with brew install git, or use a full clone.",
      );
    } else {
      expect(offline?.detail).toContain(
        "--no-lazy-fetch unsupported; full clone",
      );
      expect(offline?.fix).toBeUndefined();
    }
  });
}
