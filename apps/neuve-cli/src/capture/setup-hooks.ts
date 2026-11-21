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
import {
  agentsFlag,
  describeFinding,
  findAgentPrograms,
  foundIds,
  installAdvice,
  type Finding,
} from "../agent-programs.ts";
import type { AgentHarness } from "./agent-hooks.ts";
import {
  captureConfigPath,
  readCaptureConfig,
  type CaptureConfig,
} from "./config.ts";
import { GIT_HOOKS, TRAILER_HOOK } from "./git-hooks.ts";
import { Identity } from "@neuve/records-core/capture";
import { setupStack } from "../stack-cli.ts";

export const SETUP_HOOKS_HELP = `Usage:
  neuve setup hooks [--repo <path>] [--agents claude-code,codex|none] [--command <executable>]
    [--session-trailer] [--claude-settings <path>] [--codex-hooks <path>] [--no-stack] [--dry-run]

Enables capture in one repository: git post-commit and post-rewrite hooks in its hooks directory,
<git common directory>/neuve/capture.json, and agent hooks in the user's configuration (default
~/.claude/settings.json for Claude Code and ~/.codex/hooks.json for Codex). Without --agents, agent
hooks are written for the agent programs found here: claude on the PATH, and the Codex the codex
account runs (asked its version, once); each one not found is said so. Agent hooks are per user and
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

/** Whether Git would run the file as a hook: its owner may execute it. */
const executableByOwner = async (path: string) =>
  ((await stat(path).catch(() => undefined))?.mode ?? 0) & 0o100 ? true : false;

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
  const script = gitHookScript(name, command, chained);
  // As for the agent hook files: a hook already as it should be is left as it is. Git skips a hook
  // without its execute bit, so one with the right text but not executable is written again.
  if (
    action === "updated" &&
    (await readFile(path, "utf8").catch(() => "")) === script &&
    (await executableByOwner(path))
  )
    return { path, action: "unchanged" };
  if (!dryRun) {
    await mkdir(hooksDirectory, { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, script);
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
  options: {
    /** For tests: the agent programs found, in place of looking on this machine. */
    readonly programs?: () => Promise<ReadonlyArray<Finding>>;
    /** For tests: the stack store, in place of the user's cache. */
    readonly stackStore?: string;
  } = {},
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

  const hookFile = (harness: AgentHarness) =>
    resolve(
      (harness === "claude-code"
        ? values["claude-settings"]
        : values["codex-hooks"]) ?? defaultHookFile(harness),
    );
  // Named, the person's choice. Otherwise the agent programs found here, and every one this
  // repository's capture.json already lists: a program not found adds nothing new and never takes
  // away what is there; only --agents removes one.
  const notFound: string[] = [];
  const agents =
    agentsFlag(values.agents) ??
    (await (async () => {
      const earlier = await readCaptureConfig(location);
      if (earlier === undefined && (await exists(captureConfigPath(location))))
        notFound.push(
          `${captureConfigPath(location)} couldn't be read, so no earlier list of agents was kept; it is written again.`,
        );
      const previous = earlier?.agents ?? [];
      const findings = await (
        options.programs ?? (() => findAgentPrograms("check"))
      )();
      const kept: AgentHarness[] = [];
      for (const finding of findings) {
        const id = finding.program.id;
        if (finding.found !== undefined) kept.push(id);
        else if (previous.includes(id)) {
          kept.push(id);
          notFound.push(
            `${describeFinding(finding)}\n${finding.program.name}'s capture is already set up, so it is kept; neuve setup hooks --agents names the agents to keep.`,
          );
        } else
          notFound.push(
            `${describeFinding(finding)}\nNo ${finding.program.name} hooks were written: ${installAdvice(finding)}, or name it with --agents.`,
          );
      }
      return kept;
    })());

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

  for (const harness of agents)
    changes.push(
      await installAgentHooks(hookFile(harness), harness, command, dryRun),
    );

  const lines = [
    `${dryRun ? "Would enable" : "Enabled"} capture in ${root}`,
    `Hooks run: ${command}`,
    ...changes.map((change) => `  ${change.path}: ${change.action}`),
    ...notFound,
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
      ...(options.stackStore === undefined
        ? {}
        : { storeRoot: options.stackStore }),
    })),
  );
  await Bun.write(Bun.stdout, `${lines.join("\n")}\n`);
  return 0;
};

/** Each agent's hook file, where `setup hooks` writes it unless told otherwise. */
export const defaultHookFile = (harness: AgentHarness, home = homedir()) =>
  harness === "claude-code"
    ? join(
        process.env["CLAUDE_CONFIG_DIR"] ?? join(home, ".claude"),
        "settings.json",
      )
    : join(process.env["CODEX_HOME"] ?? join(home, ".codex"), "hooks.json");

/**
 * What one part of capture needs, read without writing: `ok` (as it should be), `update` (Neuve's
 * own, but not what this setup writes, or calling a program that isn't there) or `missing`. There is
 * no `remove` yet: this version drops nothing, and an agent's hook entries are the user's, shared by
 * every repository, so one repository can't say another doesn't want them.
 */
export interface CapturePart {
  readonly path: string;
  /** `unclear`: Neuve can't read the hook command surely enough to judge it. */
  readonly state: "ok" | "update" | "missing" | "unclear";
  readonly why?: string;
}

/**
 * The files an agent hook entry needs, read back from the command `setup hooks` wrote: the program
 * it starts and, when that program is `bun` (a hook written from a source checkout), the script it
 * runs. Undefined when the command can't be read that surely: a bare or relative first word, or a
 * quoted one with an apostrophe in it. Such an entry is reported as one Neuve can't judge, never as
 * gone.
 */
const filesCalledBy = (command: string): ReadonlyArray<string> | undefined => {
  const inner =
    /^sh -c '(.*)'$/s.exec(command)?.[1]?.replaceAll(`'\\''`, "'") ?? command;
  const words: string[] = [];
  let rest = inner.trim();
  while (rest !== "" && !rest.startsWith(">")) {
    const quoted = /^'([^']*)'(?=\s|$)/.exec(rest);
    const bare = /^([^\s']+)(?=\s|$)/.exec(rest);
    const word = quoted ?? bare;
    if (word === null) return undefined;
    words.push(word[1]!);
    rest = rest.slice(word[0].length).trimStart();
  }
  const program = words[0];
  if (program === undefined || !isAbsolute(program)) return undefined;
  if (!/(^|\/)bun$/.test(program)) return [program];
  const script = words.find((word) => word.endsWith(".js"));
  return script !== undefined && isAbsolute(script)
    ? [program, script]
    : [program];
};

/** A file an entry needs is there: the program runnable, a script readable. */
const present = async (path: string) => {
  try {
    const entry = await stat(path);
    return (
      entry.isFile() && (path.endsWith(".js") || (entry.mode & 0o111) !== 0)
    );
  } catch {
    return false;
  }
};

const runnable = present;

/**
 * Capture in one repository as `neuve setup hooks` would leave it, compared with what is there,
 * without writing: its capture.json and Git hooks, and Neuve's entries in the person's agent hook
 * files. Those entries are per user, shared by every repository, so they are judged on what holds
 * for all of them: an entry whose program is gone or can't run needs an update wherever it is seen,
 * even from a repository with no capture; a listed agent with no Neuve entries is missing. Which
 * live copy an entry calls is not judged, since another repository may have set it up with another.
 * `configured` is false when this repository has no capture.json.
 */
export const inspectCapture = async (
  root: string,
  hookFiles: (harness: AgentHarness) => string = (harness) =>
    defaultHookFile(harness),
): Promise<
  { configured: boolean; parts: ReadonlyArray<CapturePart> } | undefined
> => {
  const located = await Effect.runPromiseExit(resolveStoreLocation(root));
  if (Exit.isFailure(located)) return undefined;
  const location = located.value;
  const configPath = captureConfigPath(location);
  const config = await readCaptureConfig(location);
  const parts: CapturePart[] = [];
  let command: string | undefined;
  let dead = false;
  if (config === undefined) {
    if (await exists(configPath))
      parts.push({
        path: configPath,
        state: "update",
        why: "it isn't a capture.json this neuve can read",
      });
  } else {
    const program = config.hookCommand[0]!;
    command = config.hookCommand.map(quote).join(" ");
    dead = !(await runnable(program));
    parts.push(
      dead
        ? {
            path: configPath,
            state: "update",
            why: `its hooks run ${program}, which isn't there or can't run`,
          }
        : { path: configPath, state: "ok" },
    );
    const hooksPath = await git(root, [
      "rev-parse",
      "--git-path",
      "hooks",
    ]).catch(() => undefined);
    const hooksDirectory =
      hooksPath === undefined
        ? undefined
        : isAbsolute(hooksPath)
          ? hooksPath
          : resolve(root, hooksPath);
    for (const name of hooksDirectory === undefined ? [] : config.gitHooks) {
      const path = join(hooksDirectory!, name);
      const current = await readFile(path, "utf8").catch(() => undefined);
      const chained = await exists(join(hooksDirectory!, `${name}.pre-neuve`));
      parts.push(
        current === undefined || !current.includes(MARKER)
          ? {
              path,
              state: "missing",
              why:
                current === undefined
                  ? "there is no hook"
                  : "the hook there isn't Neuve's",
            }
          : current !== gitHookScript(name, command, chained)
            ? {
                path,
                state: "update",
                why: "it isn't the hook this setup writes",
              }
            : !(await executableByOwner(path))
              ? {
                  path,
                  state: "update",
                  why: "it can't be executed, so Git skips it",
                }
              : dead
                ? {
                    path,
                    state: "update",
                    why: `it runs ${program}, which isn't there or can't run`,
                  }
                : { path, state: "ok" },
      );
    }
  }
  for (const harness of Identity.AGENT_HARNESSES) {
    const path = hookFiles(harness);
    let file: { hooks?: Record<string, ReadonlyArray<HookGroup>> } | undefined;
    try {
      file = JSON.parse(await readFile(await linkTarget(path), "utf8"));
    } catch {
      file = undefined;
    }
    const own = Object.values(file?.hooks ?? {})
      .flatMap((groups) => groups.flatMap((group) => group.hooks ?? []))
      .map((hook) => hook.command ?? "")
      .filter(isOwnCommand);
    const gone = new Set<string>();
    let unread = 0;
    for (const entry of own) {
      const files = filesCalledBy(entry);
      if (files === undefined) unread += 1;
      else for (const file of files) if (!(await present(file))) gone.add(file);
    }
    if (gone.size > 0)
      parts.push({
        path,
        state: "update",
        why: `Neuve's ${harness} hooks run ${[...gone].join(", ")}, which isn't there or can't run, so they capture nothing`,
      });
    else if (unread > 0)
      parts.push({
        path,
        state: "unclear",
        why: `Neuve can't tell what ${unread} of its ${harness} hook entries run, so it can't say whether they work`,
      });
    else if (config?.agents.includes(harness) === true)
      parts.push(
        own.length === 0
          ? {
              path,
              state: "missing",
              why: `there are no Neuve ${harness} hooks`,
            }
          : { path, state: "ok" },
      );
  }
  return { configured: config !== undefined, parts };
};
