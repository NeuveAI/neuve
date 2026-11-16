import {
  stat,
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { Effect, Exit } from "effect";
import {
  Registry,
  STORE_DIRECTORY_MODE,
  resolveStoreLocation,
  Starter,
} from "@neuve/records-core";
import { AGENT_HARNESSES, type AgentHarness } from "./agent-hooks.ts";
import { captureConfigPath, type CaptureConfig } from "./config.ts";
import { GIT_HOOKS, TRAILER_HOOK } from "./git-hooks.ts";
import { setupStack } from "../stack-cli.ts";

export const SETUP_HOOKS_HELP = `Usage:
  neuve setup hooks [--repo <path>] [--agents claude-code,codex|none] [--command <executable>]
    [--session-trailer] [--claude-settings <path>] [--codex-hooks <path>] [--no-stack] [--dry-run]

Enables capture in one repository: git post-commit and post-rewrite hooks in its hooks directory,
<git common directory>/neuve/capture.json, and agent hooks for Claude Code and Codex in the user's
configuration (default ~/.claude/settings.json and ~/.codex/hooks.json). Agent hooks are per user and
do nothing in repositories without capture.json. Every changed user file is backed up first.
Hooks only write the spool; the worker ingests it.

  --command          What hooks run (default: this neuve, as it was invoked).
  --session-trailer  Opt in to a Neuve-Session commit trailer (prepare-commit-msg). Off by default;
                     refused in the Neuve repository, which forbids attribution trailers.
  --no-stack         Do not set up stack sources (neuve setup stack), which this runs at its end;
                     the choice is kept in <git common directory>/neuve/stack.json.`;

/** Marks files and entries this command owns, so a rerun replaces them and leaves the rest alone. */
const MARKER = "neuve-capture-hook";
const COMMAND_MARKER = `# ${MARKER}`;

/**
 * Whether an agent hook entry is this command's: it carries the marker. Entries written before the
 * marker existed are recognised by the hook entries those versions ran, which no foreign tool names.
 */
const isOwnCommand = (command: string) =>
  command.includes(COMMAND_MARKER) ||
  command.includes("/Neuve/hook/neuve-hook.js") ||
  /\/apps\/neuve-cli\/src\/cli\.ts hook (?:claude-code|codex) [a-z-]+$/.test(
    command,
  );

const AGENT_EVENTS = [
  ["SessionStart", "session-start"],
  ["UserPromptSubmit", "user-prompt-submit"],
  ["Stop", "stop"],
  ["SubagentStart", "subagent-start"],
  ["SubagentStop", "subagent-stop"],
  ["SessionEnd", "session-end"],
] as const;

const HOOK_TIMEOUT_SECONDS = 10;

/** A compiled `neuve` binary runs hooks itself; a checkout runs a bundled snapshot of the hook entry. */
const compiled = () => Bun.main.startsWith("/$bunfs/");

/**
 * One bundle per user, beside the user-level repository registry (8.6), because the agent hooks that
 * run it are per user too; the git hooks of every set-up repository share it.
 */
const hookBundlePath = () =>
  join(dirname(Registry.registryPath()), "hook", "neuve-hook.js");

const buildHookBundle = async () => {
  const target = hookBundlePath();
  const staging = join(dirname(target), `.build-${process.pid}`);
  const result = await Bun.build({
    entrypoints: [join(import.meta.dir, "..", "hook-main.ts")],
    target: "bun",
    outdir: staging,
    naming: "neuve-hook.js",
    minify: true,
  });
  if (!result.success)
    throw new Error(
      `Bundling the hook entry failed: ${result.logs.map(String).join("; ")}`,
    );
  await rename(join(staging, "neuve-hook.js"), target);
  await rm(staging, { recursive: true, force: true });
};

/**
 * An agent hook's command. The shell wrapper discards all output and exits 0 whatever happens, even if
 * the entry is missing or fails to load: on SessionStart and UserPromptSubmit, output would be added to
 * the agent's context, and exit code 2 would block the prompt.
 */
const agentHookCommand = (prefix: string, harness: string, verb: string) =>
  `sh -c ${quote(`${prefix} ${harness} ${verb} >/dev/null 2>&1; exit 0 ${COMMAND_MARKER}`)}`;

const quote = (value: string) =>
  /^[\w@%+=:,./-]+$/.test(value)
    ? value
    : `'${value.replaceAll("'", `'\\''`)}'`;

const git = async (cwd: string, args: ReadonlyArray<string>) => {
  const child = Bun.spawn(["git", "-C", cwd, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0)
    throw new Error(stderr.trim() || `git ${args.join(" ")} failed`);
  return stdout.trim();
};

const exists = async (path: string) => {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
};

const stamp = () =>
  new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");

/**
 * Whole-file replacement by rename, after a timestamped backup of whatever was there. The file keeps
 * its permissions; a new file is private to the user, as agent configuration usually is.
 */
const replaceFile = async (path: string, content: string) => {
  let backup: string | undefined;
  let mode = 0o600;
  if (await exists(path)) {
    backup = `${path}.neuve-backup-${stamp()}`;
    await copyFile(path, backup);
    mode = (await stat(path)).mode & 0o777;
  }
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, content, { mode });
  await chmod(temporary, mode);
  await rename(temporary, path);
  return backup;
};

/**
 * The file a configuration path names: a symbolic link (common for dotfile managers) is written
 * through to its target, never replaced by a regular file. A dangling link is refused.
 */
const linkTarget = async (path: string) => {
  if (!(await exists(path)) || !(await lstat(path)).isSymbolicLink())
    return path;
  try {
    return await realpath(path);
  } catch {
    throw new Error(
      `${path} is a symbolic link to a missing file; fix the link first`,
    );
  }
};

const isNeuveRepository = async (root: string) => {
  try {
    const manifest = JSON.parse(
      await readFile(join(root, "package.json"), "utf8"),
    ) as {
      name?: unknown;
    };
    return (
      manifest.name === "neuve" &&
      (await exists(join(root, "apps", "neuve-cli")))
    );
  } catch {
    return false;
  }
};

/**
 * The git hook script: runs a hook that was there before, only if it is executable (git itself skips a
 * hook that is not, so neither may the chain), then the capture hook, silently and without failing.
 */
const gitHookScript = (name: string, command: string, chained: boolean) => {
  const run = `${command} git ${name} "$@"`;
  const lines = [
    "#!/bin/sh",
    `# ${MARKER}: written by neuve setup hooks; rerun it to update.`,
    "status=0",
  ];
  const previous = `"$(dirname "$0")/${name}.pre-neuve"`;
  if (name === "post-rewrite") {
    // Git passes the rewrite mapping on standard input; both hooks need it.
    lines.push("input=$(cat)");
    if (chained)
      lines.push(
        `if [ -x ${previous} ]; then printf '%s\\n' "$input" | ${previous} "$@"; status=$?; fi`,
      );
    lines.push(`printf '%s\\n' "$input" | ${run} >/dev/null 2>&1 || true`);
  } else {
    if (chained)
      lines.push(`if [ -x ${previous} ]; then ${previous} "$@"; status=$?; fi`);
    lines.push(`${run} >/dev/null 2>&1 || true`);
  }
  lines.push("exit $status", "");
  return lines.join("\n");
};

interface Change {
  readonly path: string;
  readonly action: string;
}

const installGitHook = async (
  hooksDirectory: string,
  name: string,
  command: string,
  dryRun: boolean,
): Promise<Change> => {
  const path = join(hooksDirectory, name);
  const previous = join(hooksDirectory, `${name}.pre-neuve`);
  let chained = await exists(previous);
  let action = "installed";
  if (await exists(path)) {
    const current = await readFile(path, "utf8").catch(() => "");
    if (current.includes(MARKER)) action = "updated";
    else {
      if (chained)
        throw new Error(
          `${path} is not Neuve's and ${previous} already exists; move one aside first`,
        );
      if (!dryRun) await rename(path, previous);
      chained = true;
      action = `installed; the existing hook moved to ${previous} and still runs first whenever it is executable`;
    }
  }
  if (!dryRun) {
    await mkdir(hooksDirectory, { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, gitHookScript(name, command, chained));
    await chmod(temporary, 0o755);
    await rename(temporary, path);
  }
  return { path, action: dryRun ? `would be ${action}` : action };
};

type HookGroup = {
  matcher?: string | null;
  hooks?: Array<{ type?: string; command?: string }>;
};

/** Removes this command's earlier entries from one event's groups, keeping every other hook. */
const withoutOwn = (groups: ReadonlyArray<HookGroup>) =>
  groups
    .map((group) => ({
      ...group,
      hooks: (group.hooks ?? []).filter(
        (hook) => !isOwnCommand(hook.command ?? ""),
      ),
    }))
    .filter((group) => group.hooks.length > 0);

const installAgentHooks = async (
  path: string,
  harness: AgentHarness,
  command: string,
  dryRun: boolean,
): Promise<Change> => {
  path = await linkTarget(path);
  const present = await exists(path);
  const config = present
    ? (JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>)
    : {};
  const hooks = {
    ...((config["hooks"] as Record<string, Array<HookGroup>> | undefined) ??
      {}),
  };
  for (const [event, verb] of AGENT_EVENTS) {
    const entry = {
      type: "command",
      command: agentHookCommand(command, harness, verb),
      timeout: HOOK_TIMEOUT_SECONDS,
    };
    hooks[event] = [
      ...withoutOwn(hooks[event] ?? []),
      harness === "codex"
        ? { matcher: null, hooks: [entry] }
        : { matcher: "", hooks: [entry] },
    ];
  }
  const next = `${JSON.stringify({ ...config, hooks }, null, 2)}\n`;
  if (present && next === (await readFile(path, "utf8")))
    return { path, action: "unchanged" };
  if (dryRun)
    return { path, action: present ? "would update" : "would create" };
  const backup = await replaceFile(path, next);
  return {
    path,
    action:
      backup === undefined
        ? `created with ${AGENT_EVENTS.length} ${harness} hooks`
        : `added ${AGENT_EVENTS.length} ${harness} hooks (other settings kept); backup ${backup}`,
  };
};

export const runSetupHooks = async (
  args: readonly string[],
): Promise<number> => {
  const { values } = parseArgs({
    args: [...args],
    strict: true,
    options: {
      repo: { type: "string" },
      agents: { type: "string" },
      command: { type: "string" },
      "session-trailer": { type: "boolean" },
      "claude-settings": { type: "string" },
      "codex-hooks": { type: "string" },
      "dry-run": { type: "boolean" },
      "no-stack": { type: "boolean" },
      help: { type: "boolean" },
    },
  });
  if (values.help === true) {
    await Bun.write(Bun.stdout, `${SETUP_HOOKS_HELP}\n`);
    return 0;
  }
  const dryRun = values["dry-run"] === true;
  const root = await git(resolve(values.repo ?? process.cwd()), [
    "rev-parse",
    "--show-toplevel",
  ]);
  const agents =
    values.agents === undefined
      ? [...AGENT_HARNESSES]
      : values.agents === "none"
        ? []
        : values.agents.split(",").map((name) => {
            if (!(AGENT_HARNESSES as ReadonlyArray<string>).includes(name))
              throw new Error(
                `Unknown agent harness ${name}; expected claude-code or codex`,
              );
            return name as AgentHarness;
          });
  const sessionTrailer = values["session-trailer"] === true;
  if (sessionTrailer) {
    const superproject = await git(root, [
      "rev-parse",
      "--show-superproject-working-tree",
    ]);
    if (
      (await isNeuveRepository(root)) ||
      (superproject !== "" && (await isNeuveRepository(superproject)))
    )
      throw new Error(
        "The Neuve repository forbids attribution trailers; it links commits through post-commit records only.",
      );
  }
  if (values.command !== undefined && !isAbsolute(values.command))
    throw new Error("--command must be an absolute path");
  const argv =
    values.command === undefined
      ? [...Starter.currentCliCommand()]
      : [values.command];
  const located = await Effect.runPromiseExit(resolveStoreLocation(root));
  if (Exit.isFailure(located))
    throw new Error(`Cannot resolve the git directory of ${root}`);
  const location = located.value;
  const hooksPath = await git(root, ["rev-parse", "--git-path", "hooks"]);
  const hooksDirectory = isAbsolute(hooksPath)
    ? hooksPath
    : resolve(root, hooksPath);
  if (
    (await exists(hooksDirectory)) &&
    (await lstat(hooksDirectory)).isSymbolicLink()
  )
    throw new Error(
      `${hooksDirectory} is a symbolic link; point core.hooksPath at a real directory`,
    );

  const hookArgv =
    values.command !== undefined || compiled()
      ? [...argv, "hook"]
      : // Hooks run in the project: bun loads nothing from it (`sourceRunFlags`).
        [process.execPath, ...Starter.sourceRunFlags(), hookBundlePath()];
  if (
    hookArgv.at(-1) === hookBundlePath() &&
    !compiled() &&
    values.command === undefined &&
    !dryRun
  )
    await buildHookBundle();
  const command = hookArgv.map(quote).join(" ");

  const gitHooks = [...GIT_HOOKS, ...(sessionTrailer ? [TRAILER_HOOK] : [])];
  const changes: Array<Change> = [];
  for (const name of gitHooks)
    changes.push(await installGitHook(hooksDirectory, name, command, dryRun));

  const config: CaptureConfig = {
    version: 1,
    command: argv,
    hookCommand: hookArgv,
    gitHooks,
    agents,
    sessionTrailer,
  };
  const configPath = captureConfigPath(location);
  if (!dryRun) {
    await mkdir(location.directory, {
      recursive: true,
      mode: STORE_DIRECTORY_MODE,
    });
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
  }
  changes.push({
    path: configPath,
    action: dryRun ? "would write" : "written",
  });

  const claudeHome =
    process.env["CLAUDE_CONFIG_DIR"] ?? join(homedir(), ".claude");
  const codexHome = process.env["CODEX_HOME"] ?? join(homedir(), ".codex");
  for (const harness of agents) {
    const path =
      harness === "claude-code"
        ? (values["claude-settings"] ?? join(claudeHome, "settings.json"))
        : (values["codex-hooks"] ?? join(codexHome, "hooks.json"));
    changes.push(
      await installAgentHooks(resolve(path), harness, command, dryRun),
    );
  }

  const lines = [
    `${dryRun ? "Would enable" : "Enabled"} capture in ${root}`,
    `Hooks run: ${command}`,
    ...changes.map((change) => `  ${change.path}: ${change.action}`),
  ];
  if (agents.includes("codex"))
    lines.push(
      "Codex asks you to review and trust new hooks the next time it starts.",
    );
  // Stack sources (11.15): their own lines, so what is fetched and its caps are named.
  lines.push(
    ...(await setupStack({
      root,
      dryRun,
      ...(values["no-stack"] === true ? { off: "--no-stack" as const } : {}),
    })),
  );
  await Bun.write(Bun.stdout, `${lines.join("\n")}\n`);
  return 0;
};
