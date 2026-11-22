// Why: an upgrade changes a person's machine and repositories from a record, once, with nobody
// watching. No step of this version is added or dropped yet, so these cases drive the runner with
// fake step lists, at the boundary that matters: what the record says against what runs and what
// is written. Each failure of the slice's done-when has a case: a step added and one dropped, a
// second run, a step that asks without a terminal, a record from a newer version, a run stopped
// midway, and a listed repository whose folder is gone.
import { afterEach, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeInstallation } from "../src/installation.ts";
import { AGENT_PROGRAMS } from "../src/agent-programs.ts";
import { agentLooks, SETUP_HELP, upgradeSetup } from "../src/setup.ts";
import { plainScreen } from "../src/terminal.ts";
import {
  machineSteps,
  machineStepsRecord,
  repositorySteps,
  pendingSteps,
  repositoryStepsRecord,
  runSteps,
  type SetupStep,
  type StepsRun,
} from "../src/setup-steps.ts";

const scratches: string[] = [];
const scratch = async () => {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "neuve-steps-")),
  );
  scratches.push(directory);
  return directory;
};
afterEach(async () => {
  await Promise.all(
    scratches
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

/** A step that counts its runs; `asks` and `fails` as given. */
const step = (
  id: string,
  ran: string[],
  options: { asks?: boolean; fails?: boolean; done?: boolean } = {},
): SetupStep => ({
  id,
  scope: "repository",
  does: `does ${id}`,
  asks: options.asks ?? false,
  ...(options.done === undefined ? {} : { done: async () => options.done! }),
  run: async () => {
    if (options.fails) throw new Error(`${id} was stopped`);
    ran.push(id);
    return "applied";
  },
});

const runner = async (
  record: string,
  steps: ReadonlyArray<SetupStep>,
  {
    isTerminal = true,
    ...overrides
  }: Partial<StepsRun> & { isTerminal?: boolean } = {},
) => {
  let said = "";
  const outcome = await runSteps({
    steps,
    record,
    mode: "upgrade",
    where: "the repository",
    version: "0.3.0",
    screen: plainScreen(
      async (text) => {
        said += text;
      },
      { canAsk: isTerminal },
    ),
    now: () => new Date("2026-11-21T00:00:00.000Z"),
    ...overrides,
  });
  return { ...outcome, said };
};

const written = (record: string) =>
  readFile(record, "utf8").then(
    (text) => JSON.parse(text).steps as Record<string, unknown>,
  );

const olderRecord = async (record: string, ids: string[]) =>
  writeFile(
    record,
    JSON.stringify({
      schemaVersion: 1,
      steps: Object.fromEntries(
        ids.map((id) => [
          id,
          { appliedAt: "2026-10-01T00:00:00.000Z", by: "0.2.0" },
        ]),
      ),
    }),
  );

test("an older record gains the step a new version adds and loses the ones it drops, once", async () => {
  const record = join(await scratch(), "setup-steps.json");
  await olderRecord(record, ["kept", "undone", "reported"]);
  const ran: string[] = [];
  let undone = 0;
  const steps: SetupStep[] = [
    step("kept", ran),
    step("added", ran),
    {
      id: "undone",
      scope: "repository",
      does: "writes a file",
      asks: false,
      dropped: true,
      undo: async () => {
        undone += 1;
        return "Removed the file Neuve wrote.";
      },
    },
    {
      id: "reported",
      scope: "repository",
      does: "writes another",
      asks: false,
      dropped: true,
    },
  ];
  const first = await runner(record, steps);
  expect(ran).toEqual(["added"]);
  expect(undone).toBe(1);
  expect(first.said).toContain(
    "ok      Setup step   Removed the file Neuve wrote. (the repository)\n",
  );
  expect(first.said).toContain(
    "ok      Setup step   setup no longer writes another; this step has no undo, so what it did is left as it is (the repository)\n",
  );
  expect(Object.keys(await written(record)).sort()).toEqual(["added", "kept"]);
  // The second run runs nothing, says nothing and leaves the record's bytes as they are.
  const bytes = await readFile(record, "utf8");
  const second = await runner(record, steps);
  expect(ran).toEqual(["added"]);
  expect(undone).toBe(1);
  expect(second).toMatchObject({ said: "", changed: [] });
  expect(await readFile(record, "utf8")).toBe(bytes);
});

test("setup runs again a step that doesn't ask, and never asks twice", async () => {
  const record = join(await scratch(), "setup-steps.json");
  const ran: string[] = [];
  const steps = [step("look", ran), step("offer", ran, { asks: true })];
  await runner(record, steps, { mode: "setup" });
  const bytes = await readFile(record, "utf8");
  // A later clock: a record written again would carry a new time.
  await runner(record, steps, {
    mode: "setup",
    now: () => new Date("2026-12-24T00:00:00.000Z"),
  });
  expect(ran).toEqual(["look", "offer", "look"]);
  expect(await readFile(record, "utf8")).toBe(bytes);
});

test("a step that asks waits without a terminal, writes nothing, and is asked at one", async () => {
  const record = join(await scratch(), "setup-steps.json");
  const ran: string[] = [];
  const steps = [step("offer", ran, { asks: true })];
  const quiet = await runner(record, steps, { isTerminal: false });
  expect(ran).toEqual([]);
  expect(quiet.waiting.map((entry) => entry.id)).toEqual(["offer"]);
  expect(quiet.said).toBe(
    "to do   Setup step   waiting for a yes at a terminal (the repository): neuve setup\n",
  );
  expect(await readFile(record, "utf8").catch(() => null)).toBe(null);
  expect((await pendingSteps(steps, record)).waiting).toHaveLength(1);
  await runner(record, steps);
  expect(ran).toEqual(["offer"]);
  expect((await pendingSteps(steps, record)).waiting).toHaveLength(0);
});

test("work already there from before steps were recorded is recorded, not run", async () => {
  const record = join(await scratch(), "setup-steps.json");
  const ran: string[] = [];
  await runner(record, [step("offer", ran, { asks: true, done: true })], {
    isTerminal: false,
  });
  expect(ran).toEqual([]);
  expect(Object.keys(await written(record))).toEqual(["offer"]);
});

test("a record naming a step this build doesn't know, or a newer schema, or a damaged one, is left alone", async () => {
  const directory = await scratch();
  const ran: string[] = [];
  const steps = [step("kept", ran), step("added", ran)];
  // Every entry is by an older version, so only the unknown step can make the first one newer.
  const records: Record<string, string> = {
    "an unknown step": JSON.stringify({
      schemaVersion: 1,
      steps: { later: { appliedAt: "2026-10-01T00:00:00.000Z", by: "0.2.0" } },
    }),
    "a newer schema": JSON.stringify({ schemaVersion: 2, steps: {} }),
    damaged: "{ not json",
  };
  for (const [name, bytes] of Object.entries(records)) {
    const record = join(directory, `${name}.json`);
    await writeFile(record, bytes);
    const outcome = await runner(record, steps);
    expect(outcome.said, name).toContain(
      "to do   Setup steps  left as they are (the repository): ",
    );
    expect(outcome.said, name).toContain(
      name === "damaged" ? "is damaged" : "a newer Neuve wrote",
    );
    expect(await readFile(record, "utf8"), name).toBe(bytes);
    expect((await pendingSteps(steps, record)).left, name).toBeDefined();
  }
  expect(ran).toEqual([]);
});

// Why: a checkout runs as its package's version while a release stamps its own, so an entry's
// version must not make a record whose steps are all known look newer.
test("a record whose steps are all known is this build's to update, whatever version wrote it", async () => {
  const record = join(await scratch(), "setup-steps.json");
  await writeFile(
    record,
    JSON.stringify({
      schemaVersion: 1,
      steps: { kept: { appliedAt: "2026-12-01T00:00:00.000Z", by: "9.0.0" } },
    }),
  );
  const ran: string[] = [];
  const outcome = await runner(record, [step("kept", ran), step("added", ran)]);
  expect(outcome.left).toBeUndefined();
  expect(ran).toEqual(["added"]);
  expect(Object.keys(await written(record)).sort()).toEqual(["added", "kept"]);
});

test("a step considered for a reason is recorded with it, named by doctor, and tried again by setup", async () => {
  const record = join(await scratch(), "setup-steps.json");
  let runs = 0;
  const offer: SetupStep = {
    id: "offer",
    scope: "repository",
    does: "offers a thing",
    asks: true,
    run: async () => {
      runs += 1;
      return { considered: "no program was found" };
    },
  };
  await runner(record, [offer]);
  expect(await written(record)).toMatchObject({
    offer: { outcome: "considered", reason: "no program was found" },
  });
  expect(await pendingSteps([offer], record)).toMatchObject({
    waiting: [],
    considered: [{ reason: "no program was found" }],
  });
  // The upgrade leaves it; setup, which may now find a program, asks again.
  const bytes = await readFile(record, "utf8");
  await runner(record, [offer]);
  expect(runs).toBe(1);
  expect(await readFile(record, "utf8")).toBe(bytes);
  await runner(record, [offer], { mode: "setup" });
  expect(runs).toBe(2);
  expect(await readFile(record, "utf8")).toBe(bytes);
});

test("the upgrade's look that stores nothing is recorded as checked, and setup's full look replaces it", async () => {
  const record = join(await scratch(), "setup-steps.json");
  const look = (result: "applied" | "checked"): SetupStep => ({
    id: "look",
    scope: "machine",
    does: "looks",
    asks: false,
    run: async () => result,
  });
  await runner(record, [look("checked")]);
  expect((await written(record))["look"]).toMatchObject({ outcome: "checked" });
  await runner(record, [look("applied")], { mode: "setup" });
  expect((await written(record))["look"]).not.toHaveProperty("outcome");
});

test("a run stopped midway keeps what it applied, and the next run finishes", async () => {
  const record = join(await scratch(), "setup-steps.json");
  const ran: string[] = [];
  await expect(
    runner(record, [step("first", ran), step("second", ran, { fails: true })]),
  ).rejects.toThrow("second was stopped");
  expect(Object.keys(await written(record))).toEqual(["first"]);
  await runner(record, [step("first", ran), step("second", ran)]);
  expect(ran).toEqual(["first", "second"]);
  expect(Object.keys(await written(record))).toEqual(["first", "second"]);
});

test("the upgrade visits each repository set up here, skips one whose folder is gone, and sets none up", async () => {
  const root = await scratch();
  const home = join(root, "home");
  const repository = async (name: string) => {
    const path = join(root, name);
    await mkdir(path, { recursive: true });
    Bun.spawnSync(["git", "init", "-q", path]);
    return path;
  };
  const setUp = await repository("set-up");
  const bare = await repository("never-set-up");
  const { layout } = await writeInstallation(setUp, {
    cliBinary: "/opt/neuve/bin/neuve",
    graphBinary: "/opt/neuve/lib/neuve/entire-graph",
  });
  const registry = join(root, "repositories.json");
  const gone = join(root, "gone");
  await writeFile(
    registry,
    JSON.stringify({
      version: 1,
      repositories: [setUp, bare, gone].map((path) => ({
        store: join(path, ".git/neuve"),
        repository: path,
      })),
    }),
  );
  const ran: string[] = [];
  let said = "";
  const upgrade = () =>
    upgradeSetup({
      home,
      registry,
      machine: [{ ...step("machine-step", ran), scope: "machine" }],
      repository: (stateDirectory) => [step(`in ${stateDirectory}`, ran)],
      version: "0.3.0",
      screen: plainScreen(
        async (text) => {
          said += text;
        },
        { canAsk: false },
      ),
    });
  await upgrade();
  expect(ran).toEqual(["machine-step", `in ${layout.directory}`]);
  expect(said).toContain(
    `skipped Repository   ${gone}: its folder is gone; Neuve's list of repositories still names it\n`,
  );
  expect(said).toContain("in 1 repository set up here");
  expect(Object.keys(await written(machineStepsRecord(home)))).toEqual([
    "machine-step",
  ]);
  expect(
    Object.keys(await written(repositoryStepsRecord(layout.directory))),
  ).toHaveLength(1);
  expect(
    await readFile(join(bare, ".git/neuve/setup/setup-steps.json")).catch(
      () => null,
    ),
  ).toBe(null);
  await upgrade();
  expect(ran).toHaveLength(2);
});

test("a step the person's flag leaves out is not run or reported, and is recorded as considered for it", async () => {
  const record = join(await scratch(), "setup-steps.json");
  const ran: string[] = [];
  const left = {
    ...step("offer", ran, { asks: true }),
    leftOut: "--no-skills left it out",
  };
  const quiet = await runner(record, [left], { isTerminal: false });
  expect(quiet).toMatchObject({ said: "", waiting: [] });
  expect(await written(record)).toMatchObject({
    offer: { outcome: "considered", reason: "--no-skills left it out" },
  });
  expect((await pendingSteps([left], record)).waiting).toHaveLength(0);
  // One already asked stays as it was.
  await olderRecord(record, ["offer"]);
  const bytes = await readFile(record, "utf8");
  await runner(record, [left], { mode: "setup" });
  expect(await readFile(record, "utf8")).toBe(bytes);
  expect(ran).toEqual([]);
});

// Why: the install script calls setup upgrade only when the new copy's help names it on one line.
test("setup's help names neuve setup upgrade on one line, as the install script looks for it", () => {
  expect(
    SETUP_HELP.split("\n").some((line) => line.includes("neuve setup upgrade")),
  ).toBe(true);
});

test("a repository whose steps stop is said so, the others still get theirs, and the upgrade fails", async () => {
  const root = await scratch();
  const registry = join(root, "repositories.json");
  const paths: string[] = [];
  for (const name of ["first", "second"]) {
    const path = join(root, name);
    await mkdir(path);
    Bun.spawnSync(["git", "init", "-q", path]);
    await writeInstallation(path, {
      cliBinary: "/opt/neuve/bin/neuve",
      graphBinary: "/opt/neuve/lib/neuve/entire-graph",
    });
    paths.push(path);
  }
  await writeFile(
    registry,
    JSON.stringify({
      version: 1,
      repositories: paths.map((path) => ({
        store: join(path, ".git/neuve"),
        repository: path,
      })),
    }),
  );
  const ran: string[] = [];
  let said = "";
  const code = await upgradeSetup({
    home: join(root, "home"),
    registry,
    machine: [],
    repository: (stateDirectory) => [
      step(stateDirectory.includes("/first/") ? "first" : "second", ran, {
        fails: stateDirectory.includes("/first/"),
      }),
    ],
    version: "0.3.0",
    screen: plainScreen(
      async (text) => {
        said += text;
      },
      { canAsk: false },
    ),
  });
  expect(code).toBe(1);
  expect(ran).toEqual(["second"]);
  expect(said).toContain(
    `failed  Setup steps  stopped in ${paths[0]}: first was stopped. To finish them: neuve setup upgrade\n`,
  );
});

// Why: the upgrade's look asks only what run time would start, so it must record that it stored
// nothing, and must never record "nothing found", which would stop every later upgrade's look.
test("the upgrade's own look is recorded as checked, and when it finds nothing it is left to do", async () => {
  const record = join(await scratch(), "setup-steps.json");
  const claude = AGENT_PROGRAMS.find(
    (program) => program.id === "claude-code",
  )!;
  const run = async (found: boolean) => {
    let said = "";
    const looks = agentLooks(["claude-code"], "upgrade", false, {
      find: async () => [
        {
          program: claude,
          ...(found
            ? { found: { path: "/opt/claude", how: "found on the PATH" } }
            : {}),
          lines: [],
          strangers: [],
        },
      ],
      screen: plainScreen(async (text) => {
        said += text;
      }),
    });
    await runner(record, machineSteps(looks.look));
    return said;
  };
  const nothing = await run(false);
  expect(nothing).toContain(
    "to do   Agents       none found where run time looks; to look everywhere: neuve setup\n",
  );
  expect(await readFile(record, "utf8").catch(() => null)).toBe(null);
  await run(true);
  expect((await written(record))["agent-programs"]).toMatchObject({
    outcome: "checked",
  });
});

test("a list of repositories that can't be read is said, and the upgrade fails", async () => {
  const root = await scratch();
  const registry = join(root, "repositories.json");
  await writeFile(registry, "{ not a list");
  let said = "";
  const code = await upgradeSetup({
    home: join(root, "home"),
    registry,
    machine: [],
    repository: () => [],
    version: "0.3.0",
    screen: plainScreen(
      async (text) => {
        said += text;
      },
      { canAsk: false },
    ),
  });
  expect(code).toBe(1);
  expect(said).toContain(
    `Neuve's list of repositories, ${registry}, can't be read`,
  );
  expect(said).not.toContain("are up to date");
});

// Why: the summary is what a person reads at the end of an install; it must call a place up to
// date only by the rule doctor uses, so a step left to do is never hidden behind "up to date".
test("the summary names a machine or repository with a step still to do, as doctor does", async () => {
  const root = await scratch();
  const repo = join(root, "repo");
  await mkdir(repo);
  Bun.spawnSync(["git", "init", "-q", repo]);
  await writeInstallation(repo, {
    cliBinary: "/opt/neuve/bin/neuve",
    graphBinary: "/opt/neuve/lib/neuve/entire-graph",
  });
  const registry = join(root, "repositories.json");
  await writeFile(
    registry,
    JSON.stringify({
      version: 1,
      repositories: [{ store: join(repo, ".git/neuve"), repository: repo }],
    }),
  );
  const skipping = (
    id: string,
    scope: "machine" | "repository",
  ): SetupStep => ({
    id,
    scope,
    does: `does ${id}`,
    asks: false,
    run: async () => "skipped",
  });
  const fine = (id: string, scope: "machine" | "repository"): SetupStep => ({
    id,
    scope,
    does: `does ${id}`,
    asks: false,
    run: async () => "applied",
  });
  for (const [machine, repository, where] of [
    [
      skipping("m", "machine"),
      fine("r", "repository"),
      "this machine, where setup does m",
    ],
    [
      fine("m", "machine"),
      skipping("r", "repository"),
      `${repo}, where setup does r`,
    ],
  ] as const) {
    const home = join(root, `home-${where.length}`);
    let said = "";
    await upgradeSetup({
      home,
      registry,
      machine: [machine],
      repository: () => [repository],
      version: "0.3.0",
      screen: plainScreen(
        async (text) => {
          said += text;
        },
        { canAsk: false },
      ),
    });
    expect(said, where).not.toContain("are up to date");
    expect(said, where).toContain(
      `still to do (${where.startsWith("this machine") ? "this machine" : repo}): neuve setup\n`,
    );
    // Doctor says the same of each place.
    const machinePending = await pendingSteps(
      [machine],
      machineStepsRecord(home),
    );
    const repositoryPending = await pendingSteps(
      [repository],
      repositoryStepsRecord(join(repo, ".git/neuve/setup")),
    );
    expect(machinePending.waiting.length, where).toBe(
      where.startsWith("this machine") ? 1 : 0,
    );
    expect(repositoryPending.waiting.length, where).toBe(
      where.startsWith("this machine") ? 0 : 1,
    );
    await rm(repositoryStepsRecord(join(repo, ".git/neuve/setup")), {
      force: true,
    });
  }
});

test("work already there counts before a flag that leaves the step out, and doctor doesn't list it", async () => {
  const record = join(await scratch(), "setup-steps.json");
  const ran: string[] = [];
  const there = {
    ...step("offer", ran, { asks: true, done: true }),
    leftOut: "--no-skills left it out",
  };
  expect((await pendingSteps([there], record)).waiting).toHaveLength(0);
  await runner(record, [there], { isTerminal: false });
  expect((await written(record))["offer"]).not.toHaveProperty("outcome");
});

test("a record that isn't a plain file is left alone", async () => {
  const directory = await scratch();
  const ran: string[] = [];
  const folder = join(directory, "folder.json");
  await mkdir(folder);
  const target = join(directory, "target.json");
  await olderRecord(target, []);
  const link = join(directory, "link.json");
  await symlink(target, link);
  for (const record of [folder, link]) {
    const outcome = await runner(record, [step("added", ran)]);
    expect(outcome.said, record).toContain("is damaged");
  }
  expect(ran).toEqual([]);
  expect(await readFile(target, "utf8")).toContain('"steps":{}');
});

test("the skill offer records no 'no program found' from the upgrade's narrow look, but does from setup's", async () => {
  const root = await scratch();
  const context = {
    home: join(root, "home"),
    claudeConfigDir: undefined,
    cwd: root,
    version: "0.1.0",
    source: (await import("../src/skills-cli.ts")).findSkillSource,
    programs: async () => [],
    isTerminal: true,
    ask: async () => "n",
    out: async () => {},
    now: () => new Date(),
  };
  for (const narrow of [true, false]) {
    const state = join(root, `state-${narrow}`);
    const record = repositoryStepsRecord(state);
    await runner(
      record,
      repositorySteps(state, async () => [], undefined, narrow, context),
    );
    const kept = await readFile(record, "utf8").catch(() => null);
    if (narrow) expect(kept).toBe(null);
    else
      expect(JSON.parse(kept!).steps["skill-offer"]).toMatchObject({
        outcome: "considered",
      });
  }
});

test("a list of repositories that exists but is a folder is said to be unreadable, and the upgrade fails", async () => {
  const root = await scratch();
  const registry = join(root, "repositories.json");
  await mkdir(registry);
  let said = "";
  const code = await upgradeSetup({
    home: join(root, "home"),
    registry,
    machine: [],
    repository: () => [],
    version: "0.3.0",
    screen: plainScreen(
      async (text) => {
        said += text;
      },
      { canAsk: false },
    ),
  });
  expect(code).toBe(1);
  expect(said).toContain(
    `Neuve's list of repositories, ${registry}, can't be read`,
  );
  expect(said).not.toContain("are up to date");
});

test("a repository whose setup record can't be read is said, and counts as not up to date", async () => {
  const root = await scratch();
  const repo = join(root, "repo");
  await mkdir(repo);
  Bun.spawnSync(["git", "init", "-q", repo]);
  const { layout } = await writeInstallation(repo, {
    cliBinary: "/opt/neuve/bin/neuve",
    graphBinary: "/opt/neuve/lib/neuve/entire-graph",
  });
  await writeFile(layout.config, "{ damaged");
  const registry = join(root, "repositories.json");
  await writeFile(
    registry,
    JSON.stringify({
      version: 1,
      repositories: [{ store: join(repo, ".git/neuve"), repository: repo }],
    }),
  );
  let said = "";
  await upgradeSetup({
    home: join(root, "home"),
    registry,
    machine: [],
    repository: () => [],
    version: "0.3.0",
    screen: plainScreen(
      async (text) => {
        said += text;
      },
      { canAsk: false },
    ),
  });
  expect(said).toContain(
    `to do   Repository   ${repo}: its setup record can't be read`,
  );
  expect(said).not.toContain("are up to date");
});
