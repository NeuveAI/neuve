import { checkSignIn } from "./doctor.ts";
import { writePrivateEnvironment } from "./private-environment.ts";
import { REVIEW_DESK_COMMAND } from "./review-desk-config.ts";
import { quote } from "./shell-quote.ts";
import { defaultSkillsContext, type SkillsContext } from "./skills-cli.ts";
import { commandScreen, shown, type Screen } from "./terminal.ts";
import {
  AGENT_IDS,
  agentsFlag,
  findAgentPrograms,
  foundIds,
  machineOffers,
  offerInstall,
  summary,
  type Finding,
  type LookForPrograms,
  type OfferContext,
} from "./agent-programs.ts";
import type { AgentHarness } from "./capture/agent-hooks.ts";
import {
  RouteRefused,
  settingsRoute,
  SettingsUnreadable,
  writeRoute,
  type RouteName,
} from "./settings-route.ts";
import type { AccountStatus } from "@neuve/runtime";
import { constants } from "node:fs";
import {
  access,
  lstat,
  readdir,
  readFile,
  realpath,
  rm,
  rmdir,
  stat,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { Effect } from "effect";
import { Registry } from "@neuve/records-core";
import { CLI_VERSION } from "./cli-version.ts";
import {
  machineSteps,
  machineStepsRecord,
  repositorySteps,
  repositoryStepsRecord,
  runSteps,
  SKILL_LEFT_OUT,
  type SetupStep,
  type StepsOutcome,
} from "./setup-steps.ts";
import { gitAvailability, gitRefusal } from "./git-available.ts";
import { z } from "zod";
import {
  checkGraphEngine,
  discoverGraphBinary,
  type GraphEngineCheck,
} from "./graph-query.ts";

import {
  legacySetupLayout,
  readInstallation,
  readWorkingTreeRecord,
  RelocatedSetup,
  storeSetupLayout,
  type SetupLayout,
  validateInstallationState,
  writeInstallation,
} from "./installation.ts";

const git = async (repository: string, args: string[]) => {
  const child = Bun.spawn(["git", "-C", repository, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(stderr.trim());
  return stdout.trim();
};
const flagsSchema = z
  .object({
    "--repo": z.string().default(() => process.cwd()),
    "--graph-binary": z.string().optional(),
    "--cli-binary": z.string().optional(),
    // Named an index's question while setup indexed; still accepted so scripts keep working.
    "--initial-query": z.string().trim().min(1).optional(),
    // How reviews sign in; the harness's settings schema decides what it may be.
    "--route": z.string().optional(),
    // Which agent programs setup looks for: every one in the list unless named, or none.
    "--agents": z.string().optional(),
  })
  .strict();

export const SETUP_HELP = `Usage: neuve setup [--repo <path>] [--route openai|anthropic|claude] [--agents claude-code,codex|none] [--ask-install-again] [--graph-binary <path>] [--cli-binary <path>] [--no-skills] [--json]
  Set Neuve up in a Git repository (the current one by default): record this neuve and the Graph
  engine beside it, and check that the engine can work on the repository. It keeps its state with
  the repository's Records, in <git common directory>/neuve/setup/, and writes nothing in the
  working tree. Run it once per repository; every worktree of the repository shares it. neuve
  review and neuve review desk need it.
  --route sets how reviews sign in, in your Neuve settings: openai (ChatGPT, then
  neuve auth login openai), anthropic (an Anthropic API key in ANTHROPIC_API_KEY) or claude
  (your Claude subscription through Claude Code, after claude auth login). Without it, setup
  asks on a terminal when no route is set yet, and changes nothing otherwise.
  --graph-binary and --cli-binary name other built executables.
  Setup then looks for the agent programs on this machine and says what it found: Claude Code
  as the claude on PATH, asked claude --version; Codex as neuve auth program codex --find looks
  for it (the path already set, every codex on PATH, then on macOS OpenAI's installed apps), each
  started once as its app server to ask its version. The first that answers as Codex is stored
  as the codex account's program. --agents names which to look for, or none.
  For a program not found, setup offers its npm package at a terminal (default no) and otherwise
  gives the command; it installs nothing without your yes. Each program is asked about once per
  machine; --ask-install-again asks again.
  At a terminal, setup then offers the Neuve skill, which teaches the agent programs it found to
  use Neuve, once per repository (default no); --no-skills skips the offer.
  The agent programs and the skill offer are setup's named steps: each one applied is recorded,
  per machine beside your Neuve settings and per repository in its setup folder, in
  setup-steps.json. neuve setup upgrade, which the install script runs after an upgrade, runs the
  steps a new version adds and undoes those it drops.
  It prints one line per step and ends with what is left for you as exact commands; without a
  terminal the same lines are plain and nothing is asked. --json prints only setup's record on
  standard output, the lines going to standard error.
  Run neuve setup hooks --help and neuve setup stack --help for those.
`;

const executableFile = async (path: string) => {
  try {
    if (!(await stat(path)).isFile()) return false;
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/** Asks the install offer again for a program not found, whatever was answered before. */
export const ASK_INSTALL_AGAIN = "--ask-install-again";

/** Setup's flags that take no value. */
const SWITCHES = ["--no-skills", ASK_INSTALL_AGAIN, "--json"];

/** Setup's flags that take no value; `--agents` only ever says which programs. */
export const switches = (given: readonly string[]) => ({
  askAgain: given.includes(ASK_INSTALL_AGAIN),
  /** Only the setup record on standard output; what a person reads goes to standard error. */
  json: given.includes("--json"),
});

export const runSetup = async (given: readonly string[]): Promise<number> => {
  if (given.includes("--help") || given.includes("-h")) {
    await Bun.write(Bun.stdout, SETUP_HELP);
    return 0;
  }
  // The switches take no value.
  const noSkills = given.includes("--no-skills");
  const { askAgain, json } = switches(given);
  const args = given.filter((arg) => !SWITCHES.includes(arg));
  const raw: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index],
      value = args[index + 1];
    if (!flag || value === undefined || value.startsWith("--"))
      throw new Error(`Missing value for ${flag}`);
    if (flag in raw) throw new Error(`Duplicate option ${flag}`);
    raw[flag] = value;
  }
  const options = flagsSchema.parse(raw);
  const wanted = agentsFlag(options["--agents"]) ?? AGENT_IDS;
  // On a Mac without the command-line tools, git only opens Apple's installer.
  const available = gitAvailability();
  if (!available.usable) {
    await Bun.write(Bun.stderr, gitRefusal(available));
    return 1;
  }
  const repository = await realpath(
    await git(resolve(options["--repo"]), ["rev-parse", "--show-toplevel"]),
  );
  const screen = commandScreen({ json });
  await screen.header(`neuve setup ${CLI_VERSION}`);
  // The route before anything else is written: a settings file setup can't read stops it here.
  const route = await chooseRoute(options["--route"], screen);
  if ("refused" in route) {
    await Bun.write(Bun.stderr, `${route.refused}\n`);
    return 1;
  }
  // State copied or moved from elsewhere is what setup replaces; unsafe state still stops it.
  const previous = await readInstallation(repository).catch(
    (error: unknown) => {
      if (error instanceof RelocatedSetup) return undefined;
      throw error;
    },
  );
  // An engine named on the command line or in the environment must work. The one an earlier setup
  // recorded is only reused while it still runs: after a reinstall elsewhere it may be gone, and
  // the engine beside this CLI takes its place.
  const earlier =
    previous !== undefined && (await executableFile(previous.graphBinary))
      ? previous.graphBinary
      : undefined;
  const graph = await realpath(
    await discoverGraphBinary({
      override:
        options["--graph-binary"] ?? process.env.NEUVE_GRAPH_BINARY ?? earlier,
      executable: process.execPath,
    }),
  );
  const cli = await realpath(options["--cli-binary"] ?? process.execPath);
  const versionProcess = Bun.spawn([cli, "--version"], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const [version, versionCode] = await Promise.all([
    new Response(versionProcess.stdout).text(),
    versionProcess.exited,
  ]);
  if (versionCode !== 0 || !version.startsWith("neuve "))
    throw new Error(
      "Setup requires a built Neuve executable; supply --cli-binary when running source with Bun.",
    );
  // The record names both by path, in the store; nothing is linked or written in the working tree.
  const { layout, installation } = await writeInstallation(repository, {
    cliBinary: cli,
    graphBinary: graph,
  });
  await removeStoreLinks(layout);
  const moved = await removeLegacySetup(repository, layout.directory);
  await screen.step(
    "done",
    "Repository",
    `${shown(repository)}, recorded in ${shown(relative(repository, layout.directory).startsWith("..") ? layout.directory : relative(repository, layout.directory))}`,
  );
  if (moved !== "") await screen.detail([moved.trim()]);
  const revision = await git(repository, ["rev-parse", "HEAD"]);
  // A check, not an index: a review builds what it reads under its own keys.
  await screen.working("Graph engine", "checking");
  const check = await checkGraphEngine(repository, graph, revision);
  await validateInstallationState(layout);
  await writePrivateEnvironment(
    layout.initialIndex,
    JSON.stringify(check, null, 2) + "\n",
  );
  if (json)
    await Bun.write(
      Bun.stdout,
      JSON.stringify(
        {
          installation,
          revision,
          workingTreeDirty:
            (await git(repository, ["status", "--porcelain"])).length > 0,
          indexedSource:
            "nothing: the engine is checked, and reviews index what they read",
          initialIndexStatus: check.status,
          git: check.git,
          observation: layout.initialIndex,
        },
        null,
        2,
      ) + "\n",
    );
  const here = await realpath(process.cwd()).catch(() => process.cwd());
  const inside = here === repository || here.startsWith(`${repository}/`);
  const repo = inside ? "" : ` --repo ${quote(repository)}`;
  if (check.status === "error") {
    await screen.step(
      "failed",
      "Graph engine",
      `can't work on this repository: ${check.error}. Fix that, then run`,
      `neuve setup${repo}`,
    );
    await screen.closing({});
    return 1;
  }
  await screen.step(
    "done",
    "Graph engine",
    `checked at ${revision.slice(0, 12)}`,
  );
  await reviewsStep(screen, repository, route.route);
  // Then the named steps: this machine's, then this repository's.
  const programs = agentLooks(wanted, "setup", askAgain, { screen });
  const steps = { mode: "setup", version: CLI_VERSION, screen } as const;
  await runSteps({
    ...steps,
    steps: machineSteps(programs.look),
    record: machineStepsRecord(homedir()),
    where: "this machine",
  });
  await runSteps({
    ...steps,
    // --agents none names no program, so there is no one to offer the skill to: decided, not asked.
    steps: repositorySteps(
      layout.directory,
      programs.found,
      noSkills
        ? SKILL_LEFT_OUT.noSkills
        : wanted.length === 0
          ? SKILL_LEFT_OUT.noAgents
          : undefined,
      false,
      skillsContext(screen),
    ),
    record: repositoryStepsRecord(layout.directory),
    where: repository,
  });
  await screen.closing({ next: `neuve review HEAD~1..HEAD${repo}` });
  return 0;
};

/** The skill offer's surroundings: setup's own screen, so it looks and asks the same way. */
const skillsContext = (screen: Screen): SkillsContext => ({
  ...defaultSkillsContext(),
  isTerminal: screen.canAsk,
  out: screen.print,
  screen,
});

/**
 * The agent programs for setup's steps. In setup, `find` is setup's own look with the install
 * offer. In an upgrade, which the install script runs, it asks only what run time would start (the
 * stored path, else the PATH's `codex`), says what no longer answers, and offers nothing: no
 * installed app is started and nothing is installed from inside an install. `found` is what the
 * look found, or that same check, asked once.
 */
export const agentLooks = (
  wanted: ReadonlyArray<AgentHarness>,
  mode: "setup" | "upgrade",
  askAgain = false,
  /** Where it speaks, and for tests the narrow look. */
  narrow: {
    find?: typeof findAgentPrograms;
    screen?: Screen;
  } = {},
) => {
  const find = narrow.find ?? findAgentPrograms;
  const screen = narrow.screen ?? commandScreen({});
  let found: Promise<ReadonlyArray<AgentHarness>> | undefined;
  const check = async () => {
    await screen.working("Agents", "asking each program its version");
    const findings = await find("check", undefined, wanted);
    for (const finding of findings) {
      await showFinding(screen, finding);
      if (finding.stale !== undefined)
        await screen.detail([
          `The path stored for it, ${shown(finding.stale)}, no longer answers.`,
        ]);
    }
    const ids = foundIds(findings);
    // The upgrade looks only where run time would start a program; setup looks everywhere.
    if (ids.length === 0)
      await screen.step(
        "needs",
        "Agents",
        "none found where run time looks; to look everywhere",
        "neuve setup",
      );
    return ids;
  };
  return {
    /**
     * The machine step's run. In an upgrade, `checked`, since that look stores nothing; and when it
     * finds nothing, `skipped`, so the step stays unrecorded and a later look isn't stopped by it.
     */
    look: async (): Promise<"applied" | "checked" | "skipped"> => {
      found ??=
        mode === "upgrade"
          ? check()
          : setUpAgentPrograms(wanted, { ...offerContext(screen), askAgain });
      const ids = await found;
      if (mode === "setup") return "applied";
      return ids.length === 0 ? "skipped" : "checked";
    },
    found: () => (found ??= find("check", undefined, wanted).then(foundIds)),
    /** Whether `found` comes from the narrow look, which can't say no program is here. */
    narrow: mode === "upgrade",
  };
};

/** One program's line: found with its summary, or why looking failed; a missing one is the offer's. */
const showFinding = async (screen: Screen, finding: Finding) => {
  const line = summary(finding);
  if (line !== undefined)
    return screen.step("done", finding.program.name, line);
  await screen.step(
    finding.problem === undefined ? "needs" : "failed",
    finding.program.name,
    finding.problem === undefined
      ? "not found"
      : `looking for it failed: ${finding.problem}`,
    finding.problem === undefined
      ? finding.program.install.join(" ")
      : undefined,
  );
};

export const SETUP_UPGRADE_HELP = `Usage: neuve setup upgrade [--no-skills]
  What the install script runs once it has installed a new version: the setup steps this version
  adds, on this machine and in each repository set up here, and the undoing of those it drops.
  The repositories are those in Neuve's list of repositories with a Records store; one whose folder
  is gone is skipped and said so, and one that was never set up is left alone. A step that needs
  an answer is asked at a terminal and otherwise waits; neuve doctor shows it. --no-skills leaves
  the skill offer out. Running it again changes nothing. It looks for the agent programs only as
  run time would start them (the stored path, else the PATH's codex) and installs nothing; neuve
  setup does the full look.
`;

/** `neuve setup upgrade`, with the steps and the list of repositories given, for tests. */
export const upgradeSetup = async (input: {
  readonly home: string;
  readonly registry?: string;
  readonly machine: ReadonlyArray<SetupStep>;
  readonly repository: (stateDirectory: string) => ReadonlyArray<SetupStep>;
  readonly version: string;
  readonly screen: Screen;
}) => {
  const { screen } = input;
  const steps = { mode: "upgrade", version: input.version, screen } as const;
  let failed = 0;
  const stopped = (where: string) => async (error: unknown) => {
    failed += 1;
    await screen.step(
      "failed",
      "Setup steps",
      `stopped in ${shown(where)}: ${error instanceof Error ? error.message : String(error)}. To finish them`,
      "neuve setup upgrade",
    );
    return undefined;
  };
  const machine = await runSteps({
    ...steps,
    steps: input.machine,
    record: machineStepsRecord(input.home),
    where: "this machine",
  }).catch(stopped("this machine"));
  // What is not up to date, by the rule doctor uses: a record left alone, or steps it still
  // lacks, waiting for a terminal or not. runSteps said each one with its command.
  let behind = 0;
  const note = (outcome: StepsOutcome | undefined) => {
    if (
      outcome !== undefined &&
      (outcome.left !== undefined || outcome.toDo.length > 0)
    )
      behind += 1;
  };
  note(machine);
  const list = input.registry ?? Registry.registryPath(input.home);
  const registry = await Effect.runPromise(
    Registry.readRegistry(list).pipe(Effect.provide(BunFileSystem.layer)),
  ).catch(() => ({ repositories: [] }));
  // The list reads as empty when it can't be read; say so, since then no repository gets its steps.
  // Absent is an empty list; anything else that can't be read (a folder, no permission) is not.
  const text = await readFile(list, "utf8").catch((error: unknown) =>
    error instanceof Error && "code" in error && error.code === "ENOENT"
      ? undefined
      : null,
  );
  if (text !== undefined && registry.repositories.length === 0) {
    let readable = false;
    try {
      readable =
        text !== null && Registry.Registry.safeParse(JSON.parse(text)).success;
    } catch {
      readable = false;
    }
    if (!readable) {
      failed += 1;
      await screen.step(
        "failed",
        "Repositories",
        `Neuve's list of repositories, ${shown(list)}, can't be read, so no repository's steps ran. In each repository, run`,
        "neuve setup",
      );
    }
  }
  let visited = 0;
  for (const { repository } of registry.repositories) {
    if ((await stat(repository).catch(() => undefined)) === undefined) {
      await screen.step(
        "skipped",
        "Repository",
        `${shown(repository)}: its folder is gone; Neuve's list of repositories still names it`,
      );
      continue;
    }
    // Only a repository set up here gets setup's steps; an upgrade never sets one up.
    // A setup record that can't be read is said, and counts as not up to date.
    let set: Awaited<ReturnType<typeof readInstallation>>;
    try {
      set = await readInstallation(repository);
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      await screen.step(
        "needs",
        "Repository",
        `${shown(repository)}: its setup record can't be read (${why}). To write it again`,
        `neuve setup --repo ${quote(repository)}`,
      );
      behind += 1;
      continue;
    }
    const layout =
      set === undefined ? undefined : await storeSetupLayout(repository);
    if (set === undefined || layout === undefined) continue;
    visited += 1;
    // One repository that fails is said so, and the others still get their steps.
    const outcome = await runSteps({
      ...steps,
      steps: input.repository(layout.directory),
      record: repositoryStepsRecord(layout.directory),
      where: set.repository,
    }).catch(stopped(set.repository));
    note(outcome);
  }
  const repositories = `${visited} ${visited === 1 ? "repository" : "repositories"} set up here`;
  if (behind === 0 && failed === 0)
    await screen.step(
      "done",
      "Setup steps",
      `up to date on this machine and in ${repositories}`,
    );
  else
    await screen.step(
      failed === 0 ? "needs" : "failed",
      "Setup steps",
      `ran on this machine and in ${repositories}; ${failed === 0 ? "some still need you, as said above" : "some stopped, as said above"}`,
    );
  // Nonzero when a repository's steps stopped, so the install script says how to finish them.
  return failed === 0 ? 0 : 1;
};

export const runSetupUpgrade = async (
  given: readonly string[],
): Promise<number> => {
  if (given.includes("--help") || given.includes("-h")) {
    await Bun.write(Bun.stdout, SETUP_UPGRADE_HELP);
    return 0;
  }
  // --no-skills, as the install script was given it, leaves the skill offer out.
  const noSkills = given.includes("--no-skills");
  const other = given.find((arg) => arg !== "--no-skills");
  if (other !== undefined)
    throw new Error(
      `neuve setup upgrade takes only --no-skills, not ${other}.`,
    );
  const screen = commandScreen({});
  const programs = agentLooks(AGENT_IDS, "upgrade", false, { screen });
  return upgradeSetup({
    home: homedir(),
    machine: machineSteps(programs.look),
    repository: (stateDirectory) =>
      repositorySteps(
        stateDirectory,
        programs.found,
        noSkills ? SKILL_LEFT_OUT.noSkills : undefined,
        programs.narrow,
        skillsContext(screen),
      ),
    version: CLI_VERSION,
    screen,
  });
};

/** Setup's install offer, on setup's screen, with the machine's memory of earlier answers. */
const offerContext = (screen: Screen): OfferContext => ({
  screen,
  path: process.env["PATH"] ?? "",
  offers: machineOffers(),
});

/**
 * Setup's look at the agent programs: one line for each found (Codex's path stored as `auth
 * program codex --find` stores it), and each missing one offered from npm. The ids of those found,
 * for the skill offer.
 */
export const setUpAgentPrograms = async (
  ids: ReadonlyArray<AgentHarness>,
  context: OfferContext,
  look: LookForPrograms = findAgentPrograms,
) => {
  if (ids.length === 0) return [];
  const { screen } = context;
  await screen.working("Agents", "looking for Claude Code and Codex");
  const findings = [...(await look("find", { path: context.path }, ids))];
  // A missing program is left for the person only when none was found: one is enough.
  const optional = findings.some((finding) => finding.found !== undefined);
  for (const [index, finding] of findings.entries()) {
    // Only a program that is missing is offered; one whose look failed is not known to be.
    if (finding.found !== undefined || finding.problem !== undefined) {
      await showFinding(screen, finding);
      continue;
    }
    if (!(await offerInstall(finding, context, optional))) continue;
    const [again] = await look("find", { path: context.path }, [
      finding.program.id,
    ]);
    if (again === undefined) continue;
    findings[index] = again;
    await showFinding(screen, again);
  }
  return foundIds(findings);
};

/** The links the store's folder held while setup still linked its binaries there. */
const removeStoreLinks = async (layout: SetupLayout) => {
  for (const link of [layout.cliLink, layout.graphLink])
    if ((await lstat(link).catch(() => undefined))?.isSymbolicLink())
      await rm(link);
  await rmdir(layout.bin).catch(() => undefined);
};

/**
 * The Graph observation setup wrote as `initial-index.json`: `neuve query`'s public result for this
 * repository, top level exactly as `collectPublicQueryResult` builds it.
 */
const writtenObservation = (repository: string) =>
  z.strictObject({
    schema_version: z.number().int(),
    provider: z.object({
      name: z.literal("entire-graph"),
      version: z.string(),
      identity_revision: z.string(),
      capabilities: z.looseObject({}),
    }),
    query: z.string(),
    source: z.object({
      repository: z.literal(repository),
      revision: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
    }),
    retrieval: z.looseObject({ status: z.string() }),
    structural_observations: z.array(z.unknown()),
  });

/** What an earlier setup wrote in `neuve/`, and nothing else: relative paths, folders with `/`. */
const LEGACY_ENTRIES = new Set([
  "config.json",
  "initial-index.json",
  "bin/",
  "bin/neuve",
  "bin/neuve-graph",
]);

/** Everything under `folder`, without following links: relative paths, folders ending in `/`. */
const listFolder = async (folder: string) => {
  const entries: string[] = [];
  const visit = async (at: string, prefix: string) => {
    for (const name of await readdir(at)) {
      const info = await lstat(join(at, name));
      if (info.isDirectory()) {
        entries.push(`${prefix}${name}/`);
        await visit(join(at, name), `${prefix}${name}/`);
      } else entries.push(`${prefix}${name}`);
    }
  };
  await visit(folder, "");
  return entries;
};

/**
 * Git's answer for the folder: `none` when it tracks nothing under it, `tracked` when it tracks
 * anything there (a file deleted from the working tree included), `unknown` when Git can't say.
 */
const trackedUnder = async (repository: string, folder: string) => {
  const child = Bun.spawn(
    ["git", "-C", repository, "ls-files", "-z", "--", folder],
    { stdin: "ignore", stdout: "pipe", stderr: "ignore" },
  );
  const [stdout, code] = await Promise.all([
    new Response(child.stdout).text(),
    child.exited,
  ]);
  if (code !== 0) return "unknown" as const;
  return stdout === "" ? ("none" as const) : ("tracked" as const);
};

/**
 * Whether Git tracks one path. Only `--error-unmatch`'s exit 1 means untracked; any other failure
 * is an answer Git couldn't give.
 */
const trackedPath = async (repository: string, path: string) => {
  const child = Bun.spawn(
    ["git", "-C", repository, "ls-files", "--error-unmatch", "--", path],
    { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
  );
  const code = await child.exited;
  return code === 0
    ? ("tracked" as const)
    : code === 1
      ? ("untracked" as const)
      : ("unknown" as const);
};

/**
 * Removes what an earlier setup wrote in the working tree (`<repository>/neuve/`), now that the
 * store holds the record, only when the whole folder is provably Neuve's: it is a real folder
 * holding nothing but `config.json`, `initial-index.json` and `bin/` with its two links;
 * `config.json` is Neuve's own record naming that folder's links and this repository; the links
 * are links; `initial-index.json` is the observation setup wrote; and Git tracks nothing in the
 * folder and can say so. Anything else leaves the entire folder as it is, said in one line.
 */
const removeLegacySetup = async (repository: string, store: string) => {
  const legacy = legacySetupLayout(repository);
  const folder = await lstat(legacy.directory).catch(() => undefined);
  if (folder === undefined) return "";
  const kept = `An old neuve/ folder was left in place at ${legacy.directory}`;
  if (folder.isSymbolicLink()) return `${kept}: it is a link.\n`;
  if (!folder.isDirectory()) return "";
  // On a disk that ignores case, `neuve` also finds a project's `Neuve` or `NEUVE`; Git's paths
  // don't, so only the folder named exactly as setup named it is considered.
  if (!(await readdir(repository)).includes("neuve"))
    return `${kept}: its name differs from neuve in case only.\n`;
  const record = await readWorkingTreeRecord(repository);
  if (record === undefined)
    // No record at all is a project's own folder; a record that isn't Neuve's is left and named.
    return (await lstat(legacy.config).catch(() => undefined)) === undefined
      ? ""
      : `${kept}: its config.json isn't Neuve's setup record.\n`;
  const entries = await listFolder(legacy.directory).catch(() => undefined);
  if (entries === undefined) return `${kept}: it can't be read.\n`;
  const foreign = entries.find((entry) => !LEGACY_ENTRIES.has(entry));
  if (foreign !== undefined)
    return `${kept}: it holds ${foreign}, which setup didn't write.\n`;
  for (const link of [legacy.cliLink, legacy.graphLink]) {
    const entry = await lstat(link).catch(() => undefined);
    if (entry !== undefined && !entry.isSymbolicLink())
      return `${kept}: ${link} isn't a link setup made.\n`;
  }
  if (entries.includes("initial-index.json")) {
    const observation = await Bun.file(legacy.initialIndex)
      .json()
      .catch(() => undefined);
    if (!writtenObservation(repository).safeParse(observation).success)
      return `${kept}: ${legacy.initialIndex} isn't an index setup wrote.\n`;
  }
  const folderAnswer = await trackedUnder(repository, legacy.directory);
  if (folderAnswer !== "none")
    return folderAnswer === "tracked"
      ? `${kept}: Git tracks files in it.\n`
      : `${kept}: Git couldn't say whether it tracks files in it.\n`;
  const parts = entries
    .filter((entry) => !entry.endsWith("/"))
    .map((entry) => join(legacy.directory, entry));
  for (const part of parts) {
    const answer = await trackedPath(repository, part);
    if (answer !== "untracked")
      return answer === "tracked"
        ? `${kept}: Git tracks ${part}.\n`
        : `${kept}: Git couldn't say whether it tracks ${part}.\n`;
  }
  for (const part of parts) await rm(part);
  for (const directory of [legacy.bin, legacy.directory])
    await rmdir(directory).catch(() => undefined);
  return `Moved Neuve's setup out of the working tree, into ${store}, and removed ${legacy.directory}.\n`;
};

/**
 * How reviews sign in: the `--route` flag, else the route the settings already name, else at a
 * terminal the person's answer, ChatGPT first; Enter decides later and writes nothing. Without a
 * terminal nothing is asked or written. Setup never signs in itself; it names the next step.
 */
/** The route each answer to setup's question picks, in the order the question lists them. */
export const ROUTE_CHOICES = [
  { route: "openai", label: "ChatGPT" },
  { route: "anthropic", label: "An Anthropic API key" },
  { route: "claude", label: "Your Claude subscription, through Claude Code" },
] as const satisfies ReadonlyArray<{ route: RouteName; label: string }>;

/** What setup asks at a terminal when no route is set yet. */
export const ROUTE_QUESTION = "How should reviews sign in?";

const chooseRoute = async (
  flag: string | undefined,
  screen: Screen,
): Promise<{ refused: string } | { route: RouteName | undefined }> => {
  const write = async (route: string) => {
    try {
      await writeRoute(route);
      return { route: route as RouteName };
    } catch (error) {
      if (error instanceof SettingsUnreadable || error instanceof RouteRefused)
        return { refused: error.message };
      throw error;
    }
  };
  if (flag !== undefined) return write(flag);
  let current: RouteName | undefined;
  try {
    current = await settingsRoute();
  } catch {
    // The sign-in step and doctor say the settings can't be read; nothing is asked or written.
    return { route: undefined };
  }
  if (current !== undefined || !screen.canAsk) return { route: current };
  const picked = await screen.choose(
    ROUTE_QUESTION,
    ROUTE_CHOICES.map((choice) => ({
      value: choice.route,
      label: choice.label,
    })),
    { label: "decide later" },
  );
  return picked === undefined ? { route: undefined } : write(picked);
};

const ROUTE_NAME: Record<RouteName, string> = {
  openai: "ChatGPT",
  anthropic: "an Anthropic API key",
  claude: "your Claude subscription, through Claude Code",
};

/** The sign-in a review needs, as one step: done when it is there, else the exact command. */
const reviewsStep = async (
  screen: Screen,
  repository: string,
  route: RouteName | undefined,
) => {
  const label = "Reviews";
  if (route === "claude") {
    const step = claudeSignInStep(await claudeSignInStatus());
    return step.status === "ok"
      ? screen.step("done", label, `${ROUTE_NAME.claude}, signed in`)
      : screen.step("needs", label, step.detail, step.command);
  }
  const signIn = checkSignIn(repository);
  if (route === undefined)
    return signIn.status === "ok"
      ? screen.step(
          "done",
          label,
          `${ROUTE_NAME.anthropic} (the default), set in this shell`,
        )
      : screen.step(
          "needs",
          label,
          "choose openai (ChatGPT), anthropic (an API key) or claude (a Claude subscription)",
          "neuve setup --route <openai|anthropic|claude>",
        );
  if (signIn.status === "ok")
    return screen.step(
      "done",
      label,
      `${ROUTE_NAME[route]}, ${route === "openai" ? "signed in" : "set in this shell"}`,
    );
  return route === "openai"
    ? screen.step(
        "needs",
        label,
        "sign in with ChatGPT",
        "neuve auth login openai",
      )
    : screen.step(
        "needs",
        label,
        "an Anthropic API key (not a Claude subscription token) in the shell you run neuve from",
        "export ANTHROPIC_API_KEY=<your API key>",
      );
};

/** The Claude account's status from its check, or undefined when the check couldn't run. */
const claudeSignInStatus = async () => {
  const { checkClaudeSignIn } = await import("./auth-cli.ts");
  return checkClaudeSignIn().catch(() => undefined);
};

/**
 * Setup's sign-in step for the Claude route, from the built-in account's checked status: done when
 * Claude Code is signed in, else what is missing and the command that fixes it.
 */
export const claudeSignInStep = (
  status: AccountStatus | undefined,
): {
  status: "ok" | "missing";
  detail: string;
  command?: string;
} => {
  const state = status?.signIn;
  const login = "claude auth login";
  if (state === undefined || state.state === "unknown")
    return {
      status: "missing",
      detail:
        "Neuve couldn't check the Claude Code sign-in; to check again without spending usage",
      command: "neuve auth status claude --check",
    };
  if (state.state === "signed-in")
    return { status: "ok", detail: "Claude Code is signed in" };
  if (state.state === "runtime-unavailable")
    return state.reason === "not-installed"
      ? {
          status: "missing",
          detail:
            "Claude Code isn't installed: there's no claude on PATH. Install it, then",
          command: login,
        }
      : {
          status: "missing",
          detail: `Claude Code couldn't start (${state.reason}); to check again`,
          command: "neuve auth status claude --check",
        };
  return {
    status: "missing",
    detail:
      state.state === "credential-rejected"
        ? "Claude Code's sign-in was refused; sign in again"
        : "sign in to Claude Code with your Claude subscription",
    command: login,
  };
};
