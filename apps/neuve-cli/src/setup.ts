import { checkSignIn } from "./doctor.ts";
import { writePrivateEnvironment } from "./private-environment.ts";
import { REVIEW_DESK_COMMAND } from "./review-desk-config.ts";
import { quote } from "./shell-quote.ts";
import { offerSkillsAfterSetup } from "./skills-cli.ts";
import {
  RouteRefused,
  settingsRoute,
  SettingsUnreadable,
  writeRoute,
  type RouteName,
} from "./settings-route.ts";
import { constants } from "node:fs";
import {
  access,
  lstat,
  readdir,
  realpath,
  rm,
  rmdir,
  stat,
} from "node:fs/promises";
import { join, resolve } from "node:path";
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
  })
  .strict();

export const SETUP_HELP = `Usage: neuve setup [--repo <path>] [--route openai|anthropic] [--graph-binary <path>] [--cli-binary <path>] [--no-skills]
  Set Neuve up in a Git repository (the current one by default): record this neuve and the Graph
  engine beside it, and check that the engine can work on the repository. It keeps its state with
  the repository's Records, in <git common directory>/neuve/setup/, and writes nothing in the
  working tree. Run it once per repository; every worktree of the repository shares it. neuve
  review and neuve review desk need it.
  --route sets how reviews sign in, in your Neuve settings: openai (ChatGPT, then
  neuve auth login openai) or anthropic (an Anthropic API key in ANTHROPIC_API_KEY). Without it,
  setup asks on a terminal when no route is set yet, and changes nothing otherwise.
  --graph-binary and --cli-binary name other built executables.
  At a terminal, setup then offers the Neuve skill, which teaches Claude Code and Codex to use
  Neuve, once per repository (default no); --no-skills skips the offer.
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

export const runSetup = async (given: readonly string[]): Promise<number> => {
  if (given.includes("--help") || given.includes("-h")) {
    await Bun.write(Bun.stdout, SETUP_HELP);
    return 0;
  }
  // --no-skills takes no value: setup offers the Neuve skill at its end unless told not to.
  const noSkills = given.includes("--no-skills");
  const args = given.filter((arg) => arg !== "--no-skills");
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
  // On a Mac without the command-line tools, git only opens Apple's installer.
  const available = gitAvailability();
  if (!available.usable) {
    await Bun.write(Bun.stderr, gitRefusal(available));
    return 1;
  }
  const repository = await realpath(
    await git(resolve(options["--repo"]), ["rev-parse", "--show-toplevel"]),
  );
  // The route before anything else is written: a settings file setup can't read stops it here.
  const route = await chooseRoute(options["--route"]);
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
  const revision = await git(repository, ["rev-parse", "HEAD"]);
  // A check, not an index: a review builds what it reads under its own keys.
  const check = await checkGraphEngine(repository, graph, revision);
  await validateInstallationState(layout);
  await writePrivateEnvironment(
    layout.initialIndex,
    JSON.stringify(check, null, 2) + "\n",
  );
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
        observation: layout.initialIndex,
      },
      null,
      2,
    ) + "\n",
  );
  await Bun.write(
    Bun.stderr,
    `${moved}${route.line === undefined ? "" : `${route.line}\n`}${await nextSteps(repository, check, route.route)}`,
  );
  if (check.status === "error") return 1;
  // After the next steps: once per repository, only at a terminal; it never fails setup.
  if (!noSkills)
    await offerSkillsAfterSetup({ stateDirectory: layout.directory });
  return 0;
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
 * What setup tells a person after its JSON record (stdout, for scripts): the sign-in a review needs,
 * by either route, then the review and the desk.
 */
/**
 * How reviews sign in: the `--route` flag, else the route the settings already name, else on a
 * terminal the person's answer, ChatGPT first. Without a terminal nothing is asked or written.
 * Setup never signs in itself; it names the next step.
 */
const chooseRoute = async (
  flag: string | undefined,
): Promise<
  { refused: string } | { route: RouteName | undefined; line?: string }
> => {
  const name = (route: RouteName) =>
    route === "openai" ? "ChatGPT (the OpenAI route)" : "an Anthropic API key";
  if (flag !== undefined) {
    try {
      const path = await writeRoute(flag);
      return {
        route: flag as RouteName,
        line: `Reviews sign in with ${name(flag as RouteName)} (review.route in ${path}).`,
      };
    } catch (error) {
      if (error instanceof SettingsUnreadable || error instanceof RouteRefused)
        return { refused: error.message };
      throw error;
    }
  }
  let current: RouteName | undefined;
  try {
    current = await settingsRoute();
  } catch {
    // Doctor and the next steps say the settings can't be read; nothing is asked or written.
    return { route: undefined };
  }
  if (current !== undefined) return { route: current };
  const choose =
    "Reviews sign in with ChatGPT or an Anthropic API key. Choose with neuve setup --route openai or neuve setup --route anthropic.";
  if (!(process.stdin.isTTY === true && process.stderr.isTTY === true))
    return { route: undefined, line: choose };
  await Bun.write(
    Bun.stderr,
    "Sign in with ChatGPT, or use an Anthropic API key?\n  1. ChatGPT\n  2. An Anthropic API key\nType 1 or 2: ",
  );
  let answer = "";
  for await (const line of console) {
    answer = line.trim();
    break;
  }
  const picked: RouteName | undefined =
    answer === "1" ? "openai" : answer === "2" ? "anthropic" : undefined;
  if (picked === undefined) return { route: undefined, line: choose };
  const path = await writeRoute(picked);
  return {
    route: picked,
    line: `Reviews sign in with ${name(picked)} (review.route in ${path}).`,
  };
};

const nextSteps = async (
  repository: string,
  check: GraphEngineCheck,
  route: RouteName | undefined,
) => {
  if (check.status === "error")
    return `Neuve is set up in ${repository}, but the Graph engine can't work on it: ${check.error}\nFix that, then run neuve setup --repo ${quote(repository)} again.\n`;
  const here = await realpath(process.cwd()).catch(() => process.cwd());
  const inside = here === repository || here.startsWith(`${repository}/`);
  const repo = inside ? "" : ` --repo ${quote(repository)}`;
  const signIn = checkSignIn(repository);
  return [
    `Neuve is set up in ${repository}.`,
    "",
    "Next steps:",
    ...(route === "openai"
      ? ["  1. Sign in with ChatGPT:", "       neuve auth login openai"]
      : route === "anthropic"
        ? [
            "  1. Set ANTHROPIC_API_KEY to an Anthropic API key in the shell you run neuve from.",
            "     It must be an API key; a Claude subscription token doesn't work here.",
          ]
        : [
            "  1. Choose how reviews sign in, then sign in:",
            "       neuve setup --route openai, then neuve auth login openai (ChatGPT)",
            "       neuve setup --route anthropic, then set ANTHROPIC_API_KEY to an Anthropic API key",
            "       (an API key: a Claude subscription token doesn't work here)",
          ]),
    `     ${signIn.status === "ok" ? "Ready:" : "Not yet:"} ${signIn.detail}.`,
    "  2. Request a review of a commit range, for example the last commit:",
    `       neuve review HEAD~1..HEAD${repo}`,
    "  3. Open the batch overview and the review desk:",
    `       neuve review ${REVIEW_DESK_COMMAND}${repo}`,
    "neuve doctor checks all of this and says how to fix what is missing.",
    "",
  ].join("\n");
};
