// Why: `neuve setup` is the first thing a newcomer runs, and every review needs it. Each test runs
// the real setup (its first index needs the built Graph engine) and checks one promise:
// - it tells the person the sign-in and the next commands, with its JSON record still on stdout;
// - it keeps its record in the store, writes nothing in the working tree, and covers worktrees;
// - it checks the Graph engine and indexes nothing, since no review reads such an index;
// - Neuve's own old working-tree folder stays set up and moves into the store;
// - a recorded engine that is gone gives way to the one beside the CLI, as doctor's fix says.
import { afterAll, expect, test } from "bun:test";
import {
  lstat,
  chmod,
  mkdir,
  readFile,
  readdir,
  realpath,
  symlink,
  writeFile,
  rm,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { settingsPath } from "../../../packages/harness/src/settings.ts";
import { readInstallation, writeInstallation } from "../src/installation.ts";
import { requireRepositorySetup } from "../src/setup-status.ts";
import {
  CHECKOUT,
  CLI,
  ENGINE,
  legacyFolder,
  observation,
  prerequisite,
  removeScratch,
  scratch,
} from "./fixtures/setup-scratch.ts";

afterAll(removeScratch);

test.skipIf(prerequisite.skip)(
  "setup keeps its record in the store, leaves git status clean, covers worktrees and ends with the next steps",
  async () => {
    prerequisite.require();
    const { root, repository, home, git, copy, setup } = await scratch();
    const exclude = await readFile(
      join(repository, ".git/info/exclude"),
      "utf8",
    );
    const { stdout, stderr, code } = await setup();
    expect(code, stderr).toBe(0);
    const store = join(repository, ".git/neuve/setup");
    expect(JSON.parse(stdout)).toMatchObject({
      installation: {
        schemaVersion: 4,
        repository,
        cliBinary: await realpath(copy),
        graphBinary: await realpath(ENGINE),
      },
      git: {
        gitVersion: expect.stringContaining("git version "),
        supportsNoLazyFetch: expect.any(Boolean),
        partialClone: false,
      },
      workingTreeDirty: false,
      observation: join(store, "initial-index.json"),
    });
    // Nothing in the working tree, nothing in the exclude file, no links: git sees no change.
    expect(
      git("status", "--porcelain", "--untracked-files=all", "--ignored"),
    ).toBe("");
    expect((await readdir(repository)).sort()).toEqual([".git", "a.ts"]);
    expect(await readFile(join(repository, ".git/info/exclude"), "utf8")).toBe(
      exclude,
    );
    // With --agents none there is no program to offer the skill to, so the skill step is decided
    // without asking: recorded as considered, with that reason, and nothing is said about waiting.
    // The same on every machine, whatever agent programs it has.
    expect((await readdir(store)).sort()).toEqual([
      "config.json",
      "initial-index.json",
      "setup-steps.json",
    ]);
    expect(
      JSON.parse(await readFile(join(store, "setup-steps.json"), "utf8")).steps,
    ).toMatchObject({
      "skill-offer": {
        outcome: "considered",
        reason: "--agents none named no agent program to offer it to",
      },
    });
    // Setup checks the engine and indexes nothing: no Graph snapshot in the store or the shared
    // cache, because no review would read it (commit preparation builds what reviews read).
    expect(
      JSON.parse(await readFile(join(store, "initial-index.json"), "utf8")),
    ).toMatchObject({
      check: "graph-engine",
      git: JSON.parse(stdout).git,
      status: "ok",
      plan: "planned",
      revision: git("rev-parse", "HEAD"),
    });
    for (const cache of [
      join(repository, ".git/neuve/graph/cache/search"),
      join(root, "budget/graph/cache/search"),
    ])
      expect(existsSync(cache)).toBe(false);
    // One setup covers every worktree of the repository, as the store does.
    const worktree = join(dirname(repository), "worktree");
    git("worktree", "add", "-q", "--detach", worktree);
    expect(await readInstallation(worktree)).toMatchObject({ repository });
    expect(await requireRepositorySetup(worktree)).toBe(worktree);
    const settings = settingsPath(home);
    const repo = ` --repo '${repository}'`;
    expect(existsSync(settings)).toBe(false);
    expect(stderr).toBe(
      [
        // No terminal: nothing asked and nothing written about the route, one line on how to choose.
        "Reviews sign in with ChatGPT, an Anthropic API key or your Claude subscription through Claude Code. Choose with neuve setup --route openai, neuve setup --route anthropic or neuve setup --route claude.",
        `Neuve is set up in ${repository}.`,
        "",
        "Next steps:",
        "  1. Choose how reviews sign in, then sign in:",
        "       neuve setup --route openai, then neuve auth login openai (ChatGPT)",
        "       neuve setup --route anthropic, then set ANTHROPIC_API_KEY to an Anthropic API key",
        "       (an API key: a Claude subscription token doesn't work here)",
        "       neuve setup --route claude, then claude auth login (your Claude subscription,",
        "       through Claude Code)",
        `     Not yet: Reviews use the Anthropic route (the default; ${settings} names none), and ANTHROPIC_API_KEY isn't set in this shell. A review waits until a worker has it.`,
        "  2. Request a review of a commit range, for example the last commit:",
        `       neuve review HEAD~1..HEAD${repo}`,
        "  3. Open the batch overview and the review desk:",
        `       neuve review desk${repo}`,
        "neuve doctor checks all of this and says how to fix what is missing.",
        "",
      ].join("\n"),
    );
  },
  60_000,
);

test.skipIf(prerequisite.skip)(
  "Neuve's own old working-tree folder stays set up, and setup moves it into the store",
  async () => {
    prerequisite.require();
    const { root, repository, git, setup } = await scratch();
    const legacy = join(repository, "neuve");
    await mkdir(join(legacy, "bin"), { recursive: true });
    await symlink(join(root, "neuve"), join(legacy, "bin/neuve"));
    await symlink(ENGINE, join(legacy, "bin/neuve-graph"));
    // The observation as an earlier setup wrote it.
    await writeFile(
      join(legacy, "initial-index.json"),
      JSON.stringify(observation(repository, git("rev-parse", "HEAD"))),
    );
    await writeFile(
      join(legacy, "config.json"),
      JSON.stringify({
        schemaVersion: 3,
        repository,
        cliBinary: join(legacy, "bin/neuve"),
        graphBinary: join(legacy, "bin/neuve-graph"),
      }),
    );
    expect(await readInstallation(repository)).toMatchObject({
      cliBinary: join(legacy, "bin/neuve"),
    });
    const { stderr, code } = await setup();
    expect(code, stderr).toBe(0);
    const store = join(repository, ".git/neuve/setup");
    expect(stderr).toStartWith(
      `Moved Neuve's setup out of the working tree, into ${store}, and removed ${legacy}.\n`,
    );
    expect(await lstat(legacy).catch(() => undefined)).toBeUndefined();
    expect(await readInstallation(repository)).toMatchObject({
      graphBinary: await realpath(ENGINE),
    });
    expect(git("status", "--porcelain", "--untracked-files=all")).toBe("");
  },
  60_000,
);

test.skipIf(prerequisite.skip)(
  "an installed neuve's setup replaces a recorded engine that is gone with the one beside it",
  async () => {
    prerequisite.require();
    const { root, repository, run } = await scratch();
    const prefix = join(root, "prefix");
    const cli = join(prefix, "bin/neuve");
    const built = await run([
      process.execPath,
      join(CHECKOUT, "apps/neuve-cli/scripts/build.ts"),
      "--outfile",
      cli,
    ]);
    expect(built.code, built.stderr).toBe(0);
    await mkdir(join(prefix, "lib/neuve"), { recursive: true });
    await symlink(ENGINE, join(prefix, "lib/neuve/entire-graph"));
    const first = await run([
      cli,
      "setup",
      "--repo",
      repository,
      "--agents",
      "none",
    ]);
    expect(first.code, first.stderr).toBe(0);
    // The engine an earlier setup recorded is gone, as after a reinstall elsewhere.
    await writeInstallation(repository, {
      cliBinary: cli,
      graphBinary: join(root, "gone/entire-graph"),
    });
    const again = await run([
      cli,
      "setup",
      "--repo",
      repository,
      "--agents",
      "none",
    ]);
    expect(again.code, again.stderr).toBe(0);
    expect(await readInstallation(repository)).toMatchObject({
      cliBinary: await realpath(cli),
      graphBinary: await realpath(ENGINE),
    });
  },
  120_000,
);

// Why: a private 111 MB copy of the Graph engine per repository adds up on a tester's machine and
// in every scripted clone. Setup's first index uses the machine's shared Graph cache, as the
// reviews' Graph reads do: two repositories share one engine copy, and neither store holds one.
test.skipIf(prerequisite.skip)(
  "two repositories set up on one machine share one engine copy, and neither store holds an engine",
  async () => {
    prerequisite.require();
    const one = await scratch();
    const two = await scratch();
    const budget = join(one.root, "shared-budget");
    for (const { setup } of [one, two]) {
      const done = await setup(ENGINE, { NEUVE_BUDGET_DIRECTORY: budget });
      expect(done.code, done.stderr).toBe(0);
    }
    const engines = (root: string) =>
      readdir(root, { recursive: true }).then(
        (names) => names.filter((name) => name.endsWith("entire-graph")),
        () => [] as string[],
      );
    expect(await engines(join(budget, "graph/cache/executables"))).toHaveLength(
      1,
    );
    for (const { repository } of [one, two])
      expect(await engines(join(repository, ".git/neuve"))).toEqual([]);
  },
  120_000,
);

// Why: on a disk that ignores case, `neuve/` also finds a project's own `Neuve/`, which Git names
// differently, so its tracked files looked untracked and went. Only the exact name is considered.
test.skipIf(prerequisite.skip)(
  "a project's Neuve/ folder on a case-insensitive disk is never taken for setup's old folder",
  async () => {
    prerequisite.require();
    const { repository, git, commit, copy, setup } = await scratch();
    await writeFile(join(repository, "Probe"), "");
    const insensitive = existsSync(join(repository, "probe"));
    await rm(join(repository, "Probe"));
    if (!insensitive) {
      console.log("This disk tells case apart: nothing to show.");
      return;
    }
    await mkdir(join(repository, "Neuve"));
    const folder = await legacyFolder(
      repository,
      copy,
      git("rev-parse", "HEAD"),
    );
    git("add", "-A");
    await commit("b.ts", "export const b = 2;\n");
    const done = await setup();
    expect(done.code, done.stderr).toBe(0);
    expect(done.stderr).toStartWith(
      `An old neuve/ folder was left in place at ${folder}: its name differs from neuve in case only.\n`,
    );
    expect(git("status", "--porcelain")).toBe("");
  },
  60_000,
);

// Why: `neuve setup --route` is how a tester picks ChatGPT or an Anthropic API key. It writes only
// the route, names the next sign-in step, and a route the settings schema refuses stops setup
// before anything is written. Doctor then shows the route.
test.skipIf(prerequisite.skip)(
  "setup --route writes the route and names its sign-in; a refused route writes nothing",
  async () => {
    prerequisite.require();
    const { repository, home, run, copy } = await scratch();
    const settings = settingsPath(home);
    const setup = (route: string) =>
      run([
        process.execPath,
        "--no-env-file",
        CLI,
        "setup",
        "--repo",
        repository,
        "--route",
        route,
        "--cli-binary",
        copy,
        "--graph-binary",
        ENGINE,
        "--agents",
        "none",
      ]);
    const refused = await setup("chatgpt");
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain(
      'neuve setup --route takes openai (ChatGPT), anthropic (an Anthropic API key) or claude (your Claude subscription, through Claude Code), not "chatgpt".',
    );
    expect(existsSync(settings)).toBe(false);
    expect(existsSync(join(repository, ".git/neuve/setup"))).toBe(false);
    const done = await setup("openai");
    expect(done.code, done.stderr).toBe(0);
    expect(JSON.parse(await readFile(settings, "utf8"))).toEqual({
      version: 1,
      review: { route: "openai" },
    });
    expect(done.stderr).toContain(
      "  1. Sign in with ChatGPT:\n       neuve auth login openai\n",
    );
    const doctor = await run([
      process.execPath,
      "--no-env-file",
      CLI,
      "doctor",
      "--repo",
      repository,
      "--json",
    ]);
    const signIn = (
      JSON.parse(doctor.stdout) as {
        checks: Array<{ check: string; detail: string; fix?: string }>;
      }
    ).checks.find((check) => check.check === "sign-in");
    expect(signIn?.detail).toStartWith(
      `Reviews use the OpenAI route (review.route in ${settings})`,
    );
    expect(signIn?.fix).toStartWith("neuve auth login openai");
  },
  60_000,
);

// Why: a tester re-runs setup (doctor's own fix) while a worker runs. Since the worker's socket left
// the store, the engine accepts the repository then: setup's check, doctor and a refresh all work.
test.skipIf(prerequisite.skip)(
  "setup, doctor and a refresh work while the repository's worker runs",
  async () => {
    prerequisite.require();
    const { repository, git, commit, run, setup } = await scratch();
    await commit(
      "greeting.ts",
      "export function greetingFor(name: string) {\n  return `Hello, ${name}`;\n}\n",
    );
    expect((await setup()).code).toBe(0);
    const neuve = (...args: string[]) =>
      run([process.execPath, "--no-env-file", CLI, ...args]);
    const started = await neuve("worker", "start", "--repo", repository);
    expect(started.code, started.stderr).toBe(0);
    try {
      const again = await setup();
      expect(again.code, again.stderr).toBe(0);
      expect(JSON.parse(again.stdout).initialIndexStatus).toBe("ok");
      const doctor = JSON.parse(
        (await neuve("doctor", "--repo", repository, "--json")).stdout,
      ) as { checks: Array<{ check: string; status: string; detail: string }> };
      expect(doctor.checks.find((c) => c.check === "worker")?.detail).toBe(
        `A worker is running for ${repository}`,
      );
      expect(doctor.checks.find((c) => c.check === "setup")?.status).not.toBe(
        "missing",
      );
      const query = await neuve(
        "query",
        "--repo",
        repository,
        "--revision",
        git("rev-parse", "HEAD"),
        "--question",
        "greetingFor",
        "--max-results",
        "1",
        "--max-context-bytes",
        "4000",
        "--relationship-plan",
        "[]",
        "--refresh-cache",
      );
      expect(query.code, query.stderr).toBe(0);
      expect(JSON.parse(query.stdout).retrieval.status).toBe("ok");
    } finally {
      await neuve("worker", "stop", "--repo", repository);
    }
  },
  120_000,
);

for (const partialClone of [false, true]) {
  test.skipIf(prerequisite.skip)(
    `setup records old Git's assessment in a ${partialClone ? "partial" : "full"} clone`,
    async () => {
      prerequisite.require();
      const { root, repository, git, setup } = await scratch();
      if (partialClone) git("config", "remote.origin.promisor", "true");
      const hostGit = Bun.which("git");
      if (hostGit === null) throw new Error("Git unavailable");
      const tools = join(root, "tools");
      await mkdir(tools);
      await writeFile(
        join(tools, "git"),
        `#!${process.execPath}
const args = process.argv.slice(2);
if (args.includes("--no-lazy-fetch")) process.exit(129);
if (args.at(-1) === "version" || args.at(-1) === "--version") { console.log("git version 2.39.5 (Apple Git-154)"); process.exit(0); }
const result = Bun.spawnSync([${JSON.stringify(hostGit)}, ...args], { env: process.env, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
process.exit(result.exitCode);
`,
      );
      await chmod(join(tools, "git"), 0o755);
      const { stdout, stderr, code } = await setup(ENGINE, {
        PATH: `${tools}:${process.env.PATH}`,
      });
      expect(code, stderr).toBe(partialClone ? 1 : 0);
      const assessment = {
        gitVersion: "git version 2.39.5 (Apple Git-154)",
        supportsNoLazyFetch: false,
        partialClone,
      };
      expect(JSON.parse(stdout).git).toEqual(assessment);
      const recorded = JSON.parse(
        await readFile(
          join(repository, ".git/neuve/setup/initial-index.json"),
          "utf8",
        ),
      );
      expect(recorded.git).toEqual(assessment);
      expect(recorded.status).toBe(partialClone ? "error" : "ok");
      if (partialClone) {
        expect(stderr).toContain("git version 2.39.5 (Apple Git-154)");
        expect(stderr).toContain("this repository is a partial clone");
        expect(stderr).toContain(
          "Install Git 2.45 or later, for example with brew install git, or use a full clone.",
        );
        expect(stderr).not.toContain("source-unavailable");
      }
    },
  );
}
