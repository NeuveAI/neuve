// Why: setup now decides from what is on the machine which agent configuration it writes, and may
// run npm, the one install it offers. Those are the boundaries: a program not found gets no hook and
// no skill folder; nothing is installed without a typed yes at a terminal; a yes runs the npm
// package's own install and nothing else; npm missing or refusing changes nothing; a program found
// elsewhere is never offered even when an unrelated program owns its name on the PATH; and doctor
// reports a finding in setup's own words. Programs and npm are fakes: scripts in a scratch folder,
// and setup's look is handed its findings, so no real Claude Code, Codex or npm is ever started.
import { afterAll, expect, test } from "bun:test";
import { Effect } from "effect";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  AGENT_PROGRAMS,
  describeFinding,
  headline,
  offerInstall,
  type Finding,
  type OfferContext,
} from "../src/agent-programs.ts";
import { runSetupHooks } from "../src/capture/setup-hooks.ts";
import { inspectDoctor } from "../src/doctor.ts";
import { setUpAgentPrograms, switches } from "../src/setup.ts";
import { plainScreen } from "../src/terminal.ts";
import { runHook } from "../src/capture/hook-cli.ts";
import { offerSkillsAfterSetup } from "../src/skills-cli.ts";
import { found } from "./fixtures/agent-programs.ts";
import { findCodexProgram } from "@neuve/harness/runtimes";
import { AccountName, AccountStore } from "@neuve/runtime";
import { findAgentPrograms, machineOffers } from "../src/agent-programs.ts";
import { lookForCodex } from "../src/auth-cli.ts";
import { writeInstallation } from "../src/installation.ts";
import { runSkillsCli } from "../src/skills-cli.ts";

const folders: string[] = [];
afterAll(async () => {
  for (const folder of folders.splice(0))
    await rm(folder, { recursive: true, force: true });
});
const scratch = async () => {
  const folder = await mkdtemp(join(tmpdir(), "neuve-agent-programs-"));
  folders.push(folder);
  return folder;
};
const script = async (folder: string, name: string, body: string) => {
  await mkdir(folder, { recursive: true });
  const path = join(folder, name);
  await writeFile(path, `#!/bin/sh\n${body}\n`);
  await chmod(path, 0o755);
  return path;
};

/**
 * Doctor's discovery: the real one, held to what run time would start. It fails the test if doctor
 * asks for the scan, and the apps are never read, so no test can start an installed app's Codex.
 */
const runtimeOnly: typeof findCodexProgram = (config = {}) => {
  expect(config.scan).toBe(false);
  return findCodexProgram({
    ...config,
    apps: () => {
      throw new Error("doctor must not look in the installed apps");
    },
  });
};

const claude = AGENT_PROGRAMS[0]!;
const codex = AGENT_PROGRAMS[1]!;
const codexMissing = (strangers: ReadonlyArray<string> = []): Finding => ({
  program: codex,
  lines: strangers.map(
    (path) => `  ${path} (on the PATH): did not answer as Codex, skipped`,
  ),
  strangers,
});

/** An offer context that records what it said and asked; a terminal unless told otherwise. */
const offer = (
  answer: string | null | ReadonlyArray<string | null>,
  path: string,
  isTerminal = true,
): OfferContext & { said: () => string; asked: string[] } => {
  let said = "";
  const asked: string[] = [];
  const answers = Array.isArray(answer) ? [...answer] : [answer];
  return {
    screen: plainScreen(
      async (text) => {
        said += text;
      },
      {
        canAsk: isTerminal,
        ask: async (question) => {
          asked.push(question);
          return answers.length > 1 ? answers.shift()! : (answers[0] ?? null);
        },
      },
    ),
    path,
    said: () => said,
    asked,
  };
};

/** A fake npm that records its arguments and exits with `code`. */
const fakeNpm = async (code: number) => {
  const bin = join(await scratch(), "bin");
  const record = join(bin, "..", "npm-args");
  await script(bin, "npm", `printf '%s\\n' "$@" > '${record}'\nexit ${code}`);
  return {
    bin,
    args: async () =>
      existsSync(record)
        ? (await readFile(record, "utf8")).trim().split("\n")
        : undefined,
  };
};

test("with only Claude Code here, setup says Codex was not found, prints its command without a terminal, and writes no Codex hook or skill", async () => {
  const context = offer(null, "", false);
  const ids = await setUpAgentPrograms(["claude-code", "codex"], context, () =>
    found(["claude-code"]),
  );
  expect(ids).toEqual(["claude-code"]);
  expect(context.asked).toEqual([]);
  // Claude Code is enough, so the missing Codex is left out, not left for the person.
  expect(context.said()).toContain(
    "skipped Codex        not found: npm install -g @openai/codex\n",
  );

  // Hooks: only Claude Code's settings are written; Codex's file is never created.
  const root = await scratch();
  const repo = join(root, "repo");
  await mkdir(repo);
  Bun.spawnSync(["git", "init", "-q", repo]);
  const settings = join(root, "claude", "settings.json");
  const codexHooks = join(root, "codex", "hooks.json");
  expect(
    await runSetupHooks(
      [
        "--repo",
        repo,
        "--claude-settings",
        settings,
        "--codex-hooks",
        codexHooks,
        "--command",
        "/opt/neuve/bin/neuve",
        "--no-stack",
      ],
      {
        programs: () => found(["claude-code"]),
        stackStore: join(root, "stack"),
      },
    ),
  ).toBe(0);
  expect(existsSync(settings)).toBe(true);
  expect(existsSync(codexHooks)).toBe(false);

  // The skill: offered and installed for Claude Code alone.
  const home = await scratch();
  await offerSkillsAfterSetup({
    stateDirectory: join(home, "state"),
    agents: ids,
    context: {
      home,
      claudeConfigDir: undefined,
      cwd: home,
      version: "0.1.0",
      source: (await import("../src/skills-cli.ts")).findSkillSource,
      programs: () => found(["claude-code"]),
      isTerminal: true,
      ask: async () => "y",
      out: async () => {},
      now: () => new Date(),
    },
  });
  expect(existsSync(join(home, ".claude", "skills", "neuve"))).toBe(true);
  expect(existsSync(join(home, ".agents"))).toBe(false);
});

test("answering no, or nothing, installs nothing and runs nothing; an answer that is neither is asked again", async () => {
  const npm = await fakeNpm(0);
  const question = "Install Codex with npm install -g @openai/codex? [y/N] ";
  for (const answer of ["n", "", null, ["yes please", "n"]]) {
    const context = offer(answer, npm.bin);
    expect(await offerInstall(codexMissing(), context)).toBe(false);
    expect(context.asked).toEqual(
      Array.isArray(answer) ? [question, question] : [question],
    );
    expect(context.said()).toContain(`Codex        not found (${codex.page})`);
  }
  expect(await npm.args()).toBeUndefined();
});

test("answering yes runs only the npm package's own install, then setup looks for the program again", async () => {
  for (const [program, args] of [
    [codex, ["install", "-g", "@openai/codex"]],
    [claude, ["install", "-g", "@anthropic-ai/claude-code@latest"]],
  ] as const) {
    const npm = await fakeNpm(0);
    const context = offer("y", npm.bin);
    let looked = 0;
    const ids = await setUpAgentPrograms([program.id], context, async () => {
      looked += 1;
      return (await found(looked === 1 ? [] : [program.id])).filter(
        (finding) => finding.program === program,
      );
    });
    expect(await npm.args()).toEqual([...args]);
    expect(looked).toBe(2);
    expect(ids).toEqual([program.id]);
    expect(context.said()).toContain(`ok      ${program.name}`);
    expect(context.said()).toContain("/test/bin/");
  }
});

test("npm absent or refusing: setup says so and nothing else is changed", async () => {
  const absent = offer("y", await scratch());
  expect(await offerInstall(codexMissing(), absent)).toBe(false);
  expect(absent.said()).toContain(
    "failed  Codex        not installed: npm isn't on the PATH. Install npm, then run: npm install -g @openai/codex",
  );
  const npm = await fakeNpm(1);
  const refused = offer("y", npm.bin);
  expect(await offerInstall(codexMissing(), refused)).toBe(false);
  expect(await npm.args()).toEqual(["install", "-g", "@openai/codex"]);
  expect(refused.said()).toContain(
    "not installed: npm exited 1; nothing else was changed",
  );
});

test("an unrelated codex on the PATH: no offer when Codex was found elsewhere, and a plain warning when the offer runs", async () => {
  const stranger = "/usr/local/bin/codex";
  const inApp: Finding = {
    program: codex,
    found: {
      path: "/opt/apps/Example.app/Contents/Resources/codex/bin/codex",
      version: "0.0.1",
      how: "found in an installed app",
    },
    lines: [`  ${stranger} (on the PATH): did not answer as Codex, skipped`],
    strangers: [stranger],
  };
  const context = offer("y", "");
  expect(
    await setUpAgentPrograms(["codex"], context, async () => [inApp]),
  ).toEqual(["codex"]);
  expect(context.asked).toEqual([]);
  expect(context.said()).toContain(
    "ok      Codex        0.0.1 · /opt/apps/Example.app/Contents/Resources/codex/bin/codex\n",
  );

  const missing = offer("n", "");
  await offerInstall(codexMissing([stranger]), missing);
  expect(missing.said()).toContain(
    `Another program named like it is on the PATH (${stranger}) and did not answer as Codex; npm may refuse or replace it.`,
  );
});

test("doctor reports each program in setup's words, and a stored path that stops answering offers setup's look", async () => {
  const root = await scratch();
  const home = join(root, "home");
  const bin = join(root, "bin");
  const claudePath = await script(bin, "claude", "echo '2.1.0 (Claude Code)'");
  // An unrelated program that owns the name: it answers nothing Codex would.
  const stranger = await script(bin, "codex", "exit 0");
  const repository = join(root, "repo");
  await mkdir(repository);
  Bun.spawnSync(["git", "init", "-q", repository]);
  const check = async (name: string) =>
    (
      await inspectDoctor({
        repository,
        version: "0.1.0",
        home,
        path: bin,
        findCodex: runtimeOnly,
      })
    ).checks.find((entry) => entry.check === name);

  const claudeFinding: Finding = {
    program: claude,
    found: {
      path: claudePath,
      version: "2.1.0 (Claude Code)",
      how: "found on the PATH",
    },
    lines: [],
    strangers: [],
  };
  expect(await check("Claude Code")).toEqual({
    check: "Claude Code",
    status: "ok",
    detail: headline(claudeFinding),
  });
  expect(describeFinding(claudeFinding)).toBe(`${headline(claudeFinding)}.`);

  // A claude that doesn't answer its version (a stale shim, say) is not Claude Code: not found,
  // and the line says what was asked, so the file that is there isn't called absent.
  const silent = await script(join(root, "silent"), "claude", "exit 1");
  const [shim] = await findAgentPrograms(
    "check",
    { path: dirname(silent), home },
    ["claude-code"],
  );
  expect(shim?.found).toBeUndefined();
  expect(shim?.strangers).toEqual([silent]);
  expect(describeFinding(shim!)).toBe(
    `Claude Code was not found.\n  ${silent} (on the PATH): was asked its version and didn't answer`,
  );

  // Nothing stored: only the PATH's codex is asked, and it is skipped.
  const none = await check("Codex");
  expect(none?.status).toBe("ok");
  expect(none?.detail).toStartWith(
    `Codex was not found: ${stranger} (on the PATH): did not answer as Codex, skipped. It is optional: install it with npm install -g @openai/codex`,
  );

  // A stored path that no longer answers is a warning, with setup's look as the fix.
  const gone = join(root, "gone", "codex");
  const { AccountStore, AccountName } = await import("@neuve/runtime");
  AccountStore.setProgramPath(home, AccountName.parse("codex"), gone);
  expect(await check("Codex")).toEqual({
    check: "Codex",
    status: "warning",
    detail: `Codex was not found: ${gone} (set): nothing runs there. The path stored for it, ${gone}, no longer answers`,
    fix: "neuve setup, which looks for it again",
  });
});

test("a stored-paths file that can't be read is one finding, and doctor's other checks still run", async () => {
  const root = await scratch();
  const home = join(root, "home");
  const repository = join(root, "repo");
  await mkdir(repository);
  Bun.spawnSync(["git", "init", "-q", repository]);
  const { AccountStore } = await import("@neuve/runtime");
  const programs = AccountStore.programsPath(home);
  await mkdir(join(programs, ".."), { recursive: true });
  await writeFile(programs, "not json");
  const report = await inspectDoctor({
    findCodex: runtimeOnly,
    repository,
    version: "0.1.0",
    home,
    path: "",
  });
  const codexCheck = report.checks.find((entry) => entry.check === "Codex");
  expect(codexCheck?.status).toBe("warning");
  expect(codexCheck?.detail).toStartWith(
    "Codex was not found: looking for it failed (",
  );
  expect(report.checks.map((entry) => entry.check)).toContain("agent skill");
});

/** A discovery that answers with one Codex, recording what it was asked; it starts nothing. */
const discovery = (path: string) => {
  const asked: Array<Parameters<typeof findCodexProgram>[0]> = [];
  const find: typeof findCodexProgram = (config) => {
    asked.push(config);
    const candidate = { path, found: "app" as const };
    const answer = { candidate, kind: "codex" as const, version: "0.0.1" };
    return Effect.succeed({
      tried: [answer],
      found: answer,
      skippedApps: [],
      appsLookedFor: true,
    }) as ReturnType<typeof findCodexProgram>;
  };
  return { find, asked };
};
const codexName = AccountName.parse("codex");

test("setup stores the Codex it finds as the account's program, asking the stored path first", async () => {
  const home = join(await scratch(), "home");
  // Nothing runs at either path, so the account check after storing starts no program.
  const earlier = join(home, "earlier", "codex");
  const app = join(home, "apps", "Example.app", "bin", "codex");
  AccountStore.setProgramPath(home, codexName, earlier);
  const { find, asked } = discovery(app);
  const ids = await setUpAgentPrograms(
    ["codex"],
    offer(null, "", false),
    (look, surroundings, only) =>
      findAgentPrograms(look, { ...surroundings, home, findCodex: find }, only),
  );
  expect(ids).toEqual(["codex"]);
  expect(asked).toHaveLength(1);
  expect(asked[0]?.scan).not.toBe(false);
  expect(asked[0]?.setting).toBe(earlier);
  expect(AccountStore.programPath(home, codexName)).toBe(app);

  // The same function is auth program codex --find: it too asks the stored path first.
  const again = discovery(app);
  const look = await lookForCodex("find", { home, findCodex: again.find });
  expect(again.asked[0]?.setting).toBe(app);
  expect(look.stored?.path).toBe(app);
});

test("rerunning setup hooks with Codex not found keeps both agents captured; only --agents removes one", async () => {
  const root = await scratch();
  const repo = join(root, "repo");
  await mkdir(repo);
  Bun.spawnSync(["git", "init", "-q", repo]);
  const settings = join(root, "claude", "settings.json");
  const codexHooks = join(root, "codex", "hooks.json");
  const run = (
    programs: () => Promise<ReadonlyArray<Finding>>,
    extra: string[] = [],
  ) =>
    runSetupHooks(
      [
        "--repo",
        repo,
        "--claude-settings",
        settings,
        "--codex-hooks",
        codexHooks,
        "--command",
        "/opt/neuve/bin/neuve",
        "--no-stack",
        ...extra,
      ],
      { programs, stackStore: join(root, "stack") },
    );
  const captured = async () =>
    (
      JSON.parse(
        await readFile(join(repo, ".git", "neuve", "capture.json"), "utf8"),
      ) as {
        agents: string[];
      }
    ).agents;
  expect(await run(() => found())).toBe(0);
  expect(await captured()).toEqual(["claude-code", "codex"]);
  // Codex not found now (no stored path, a slow handshake): it stays captured.
  expect(await run(() => found(["claude-code"]))).toBe(0);
  expect(await captured()).toEqual(["claude-code", "codex"]);
  // The person's own instruction removes it, and a plain rerun doesn't bring it back.
  expect(
    await run(() => found(["claude-code"]), ["--agents", "claude-code"]),
  ).toBe(0);
  expect(await captured()).toEqual(["claude-code"]);
  expect(await run(() => found(["claude-code"]))).toBe(0);
  expect(await captured()).toEqual(["claude-code"]);
  // Another repository decides for itself: Codex's hooks, which are the user's, don't add it.
  const other = join(root, "other");
  await mkdir(other);
  Bun.spawnSync(["git", "init", "-q", other]);
  await runSetupHooks(
    [
      "--repo",
      other,
      "--claude-settings",
      settings,
      "--codex-hooks",
      codexHooks,
      "--command",
      "/opt/neuve/bin/neuve",
      "--no-stack",
    ],
    { programs: () => found(["claude-code"]), stackStore: join(root, "stack") },
  );
  expect(
    (
      JSON.parse(
        await readFile(join(other, ".git", "neuve", "capture.json"), "utf8"),
      ) as { agents: string[] }
    ).agents,
  ).toEqual(["claude-code"]);
});

// Why: a program removed from the machine must not get its hook file written back by a rerun of
// setup hooks; its capture stays listed (nothing is taken away), and doctor gives no fix that
// would not fix it.
test("a captured agent that is gone stays listed, gets no hooks until it is found, and doctor says so plainly", async () => {
  const root = await scratch();
  const home = join(root, "home");
  const repo = join(root, "repo");
  await mkdir(repo);
  Bun.spawnSync(["git", "init", "-q", repo]);
  const settings = join(root, "claude", "settings.json");
  const codexHooks = join(root, "codex", "hooks.json");
  const neuve = await script(join(root, "bin"), "neuve", "exit 0");
  const run = async (programs: () => Promise<ReadonlyArray<Finding>>) => {
    let printed = "";
    const write = Bun.write;
    Bun.write = (async (to: unknown, data: unknown) => {
      if (to === Bun.stdout) {
        printed += String(data);
        return String(data).length;
      }
      return write(to as never, data as never);
    }) as typeof Bun.write;
    try {
      expect(
        await runSetupHooks(
          [
            "--repo",
            repo,
            "--claude-settings",
            settings,
            "--codex-hooks",
            codexHooks,
            "--command",
            neuve,
            "--no-stack",
          ],
          { programs, stackStore: join(root, "stack") },
        ),
      ).toBe(0);
    } finally {
      Bun.write = write;
    }
    return printed;
  };
  expect(await run(() => found())).toContain(
    "Codex asks you to review and trust new hooks",
  );
  const written = await readFile(codexHooks, "utf8");
  // Codex is removed, and its hook file with it.
  await rm(join(root, "codex"), { recursive: true });
  const printed = await run(() => found(["claude-code"]));
  expect(existsSync(codexHooks)).toBe(false);
  expect(
    (
      JSON.parse(
        await readFile(join(repo, ".git", "neuve", "capture.json"), "utf8"),
      ) as { agents: string[] }
    ).agents,
  ).toEqual(["claude-code", "codex"]);
  expect(printed).toContain(
    "Codex        not found; its capture stays listed, and no hooks are written for it until it is found (--agents names the agents to keep)\n",
  );
  expect(printed).not.toContain("Codex asks you to review and trust");
  // Doctor's capture check, in a repository set up for it.
  await writeInstallation(repo, {
    cliBinary: "/opt/neuve/bin/neuve",
    graphBinary: "/opt/neuve/lib/neuve/entire-graph",
  });
  const doctor = async () =>
    (
      await inspectDoctor({
        repository: repo,
        version: "0.1.0",
        home,
        path: join(root, "no-programs"),
        findCodex: runtimeOnly,
        hookFiles: (harness) => (harness === "codex" ? codexHooks : settings),
      })
    ).checks.find((entry) => entry.check === "capture");
  const capture = await doctor();
  expect(capture?.status).toBe("ok");
  expect(capture?.detail).toContain(
    `${codexHooks}: capture.json lists codex, which isn't found here, so it has no hooks until neuve setup hooks finds it`,
  );
  // Its hook file left behind and out of date: setup hooks leaves it as it is while Codex is gone,
  // so doctor says so rather than offer a fix that writes nothing.
  const stale = written.replace(/"timeout": \d+/, '"timeout": 1');
  expect(stale).not.toBe(written);
  await mkdir(join(root, "codex"));
  await writeFile(codexHooks, stale);
  const left = await doctor();
  expect(left?.status).toBe("ok");
  expect(left?.detail).toContain(
    `${codexHooks}: Neuve's codex hooks here are out of date (`,
  );
  expect(left?.detail).toContain(
    "codex isn't found here, so they are left as they are until neuve setup hooks finds it",
  );
  await run(() => found(["claude-code"]));
  expect(await readFile(codexHooks, "utf8")).toBe(stale);
});

test("a capture.json that can't be read is written again, and setup hooks says so", async () => {
  const root = await scratch();
  const repo = join(root, "repo");
  await mkdir(repo);
  Bun.spawnSync(["git", "init", "-q", repo]);
  const config = join(repo, ".git", "neuve", "capture.json");
  await mkdir(join(config, ".."), { recursive: true });
  await writeFile(config, "{ not json");
  let printed = "";
  const write = Bun.write;
  // The command's summary goes through Bun.write to standard output; kept here to read it.
  Bun.write = (async (to: unknown, data: unknown) => {
    if (to === Bun.stdout) {
      printed += String(data);
      return String(data).length;
    }
    return write(to as never, data as never);
  }) as typeof Bun.write;
  try {
    expect(
      await runSetupHooks(
        [
          "--repo",
          repo,
          "--claude-settings",
          join(root, "claude", "settings.json"),
          "--codex-hooks",
          join(root, "codex", "hooks.json"),
          "--command",
          "/opt/neuve/bin/neuve",
          "--no-stack",
        ],
        {
          programs: () => found(["claude-code"]),
          stackStore: join(root, "stack"),
        },
      ),
    ).toBe(0);
  } finally {
    Bun.write = write;
  }
  expect(printed).toContain(
    `capture.json couldn't be read, so no earlier list of agents was kept; it is written again\n`,
  );
  expect(
    (JSON.parse(await readFile(config, "utf8")) as { agents: string[] }).agents,
  ).toEqual(["claude-code"]);
});

// Why: `neuve skills install` (and the installer's --offer) keep a copy current for a program not
// found, as doctor's fix relies on; setup's own offer is for the programs found, as its hooks are.
test("a skill already installed is kept up to date when its program isn't found, but setup's offer leaves it out", async () => {
  const home = await scratch();
  let said = "";
  const context = (programs: ReadonlyArray<string>, answer = "y") => ({
    home,
    claudeConfigDir: undefined,
    cwd: home,
    version: "0.1.0",
    source: (async () =>
      (await import("../src/skills-cli.ts")).findSkillSource()) as never,
    programs: () => found(programs),
    isTerminal: true,
    ask: async () => answer,
    out: async (text: string) => {
      said += text;
    },
    now: () => new Date(),
  });
  expect(
    await runSkillsCli(["install", "--agents", "codex"], context([])),
  ).toBe(0);
  said = "";
  expect(
    await runSkillsCli(["install", "--dry-run"], context(["claude-code"])),
  ).toBe(0);
  expect(said).toContain(
    "Its skill is already installed, so it is kept up to date.",
  );
  expect(said).toContain("Codex (user)");
  expect(said).toContain("Claude Code (user)");
  // Setup's offer is for the program setup found, Claude Code, even when Codex's copy is older.
  expect(
    await runSkillsCli(["install", "--agents", "codex"], {
      ...context([]),
      version: "0.0.9",
      source: (async () =>
        (await import("../src/skills-cli.ts")).findSkillSource({
          version: "0.0.9",
        })) as never,
    }),
  ).toBe(0);
  said = "";
  await offerSkillsAfterSetup({
    stateDirectory: join(home, "state"),
    agents: ["claude-code"],
    context: context(["claude-code"], "n"),
  });
  expect(said).toContain("for Claude Code: 8 files in ");
  expect(said).not.toContain("Codex");
});

test("the install offer asks once per machine; a yes is remembered only once npm installed it; --ask-install-again asks again", async () => {
  const home = join(await scratch(), "home");
  const offers = machineOffers(home);
  // A yes with npm missing is not remembered.
  const noNpm = { ...offer("y", await scratch()), offers };
  expect(await offerInstall(codexMissing(), noNpm)).toBe(false);
  expect(await offers.asked("codex")).toBe(false);
  // A no is remembered, and a later setup prints the command, says how to be asked, and asks nothing.
  const first = { ...offer("n", ""), offers };
  expect(await offerInstall(codexMissing(), first)).toBe(false);
  expect(first.asked).toHaveLength(1);
  const later = { ...offer("y", ""), offers };
  expect(await offerInstall(codexMissing(), later)).toBe(false);
  expect(later.asked).toEqual([]);
  expect(later.said()).toContain("neuve setup --ask-install-again asks again");
  const named = { ...offer("n", ""), offers, askAgain: true };
  await offerInstall(codexMissing(), named);
  expect(named.asked).toHaveLength(1);
  // A prompt left unanswered (the end of input) is not remembered.
  const silent = { ...offer(null, ""), offers };
  await offerInstall({ ...codexMissing(), program: claude }, silent);
  expect(silent.asked).toHaveLength(1);
  expect(await offers.asked("claude-code")).toBe(false);
  // A yes that npm carried out is remembered.
  const npm = await fakeNpm(0);
  await offerInstall(
    { ...codexMissing(), program: claude },
    {
      ...offer("y", npm.bin),
      offers,
    },
  );
  expect(await offers.asked("claude-code")).toBe(true);
  // Kept private, as the rest of Neuve's settings are.
  const { Settings } = await import("@neuve/harness");
  const file = join(Settings.settingsPath(home), "..", "install-offers.json");
  expect((await stat(file)).mode & 0o777).toBe(0o600);
});

test("setup's command line: --ask-install-again asks again, and --agents only says which programs", () => {
  expect(switches(["--ask-install-again", "--repo", "/r"])).toEqual({
    askAgain: true,
    json: false,
  });
  expect(switches(["--agents", "codex", "--json"])).toEqual({
    askAgain: false,
    json: true,
  });
});

test("the hook says in its log when capture.json can't be read, and captures nothing", async () => {
  const repo = join(await scratch(), "repo");
  await mkdir(repo);
  Bun.spawnSync(["git", "init", "-q", repo]);
  const store = join(repo, ".git", "neuve");
  await mkdir(store, { recursive: true });
  await writeFile(join(store, "capture.json"), "{ not json");
  expect(
    await runHook(
      ["claude-code", "stop"],
      JSON.stringify({ session_id: "s-1", cwd: repo }),
    ),
  ).toBe(0);
  expect(await readFile(join(store, "hooks.log"), "utf8")).toContain(
    "capture.json can't be read; neuve setup hooks writes it again",
  );
  expect(existsSync(join(store, "spool"))).toBe(false);
});

test("an answer that can't be remembered is said once and never fails the offer", async () => {
  const root = await scratch();
  // The settings folder can't be made: a file stands where it would be, on any system.
  const { Settings } = await import("@neuve/harness");
  const folder = join(Settings.settingsPath(root), "..");
  await mkdir(join(folder, ".."), { recursive: true });
  await writeFile(folder, "a file");
  const offers = machineOffers(root);
  const context = { ...offer("n", ""), offers };
  expect(await offerInstall(codexMissing(), context)).toBe(false);
  await offerInstall({ ...codexMissing(), program: claude }, context);
  expect(context.said().match(/couldn't remember this answer/g)).toHaveLength(
    1,
  );
});

// Why: one program is enough, so a missing one is left for the person only when none is there once
// the offers are answered; deciding that before an install leaves a "to do" for nothing.
test("a program installed by an offer makes the other missing one optional, whichever is asked", async () => {
  for (const [declined, asked] of [
    [codex, claude],
    [claude, codex],
  ] as const) {
    const npm = await fakeNpm(0);
    const offers = machineOffers(join(await scratch(), "home"));
    await offers.record(declined.id);
    const context = { ...offer("y", npm.bin), offers };
    let installed = false;
    const ids = await setUpAgentPrograms(
      ["claude-code", "codex"],
      context,
      async (_look, _where, wanted = ["claude-code", "codex"]) => {
        if (wanted.length === 1) installed = true;
        return (await found(installed ? [asked.id] : [])).filter((finding) =>
          wanted.includes(finding.program.id),
        );
      },
    );
    expect(ids).toEqual([asked.id]);
    expect(context.asked).toHaveLength(1);
    expect(context.said(), declined.name).toContain(
      `skipped ${declined.name.padEnd(12)} not found: ${declined.install.join(" ")}\n`,
    );
    expect(context.said(), declined.name).not.toContain(
      `to do   ${declined.name.padEnd(12)} not found:`,
    );
  }
});
