import {
  access,
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
import { constants } from "node:fs";
import { z } from "zod";
import {
  Registry,
  STORE_DIRECTORY_MODE,
  resolveStoreLocation,
  Starter,
} from "@neuve/records-core";
import {
  agentsFlag,
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
import { CLI_VERSION } from "../cli-version.ts";
import { commandScreen, shown, type Mark } from "../terminal.ts";

/** A program not found, as its own line says it after its name. */
const missingText = (finding: Finding) =>
  finding.problem === undefined
    ? "not found"
    : `looking for it failed (${finding.problem})`;

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

/*
 * What reading a hook file guarantees (an agent's hook file, or a Git hook), for `setup hooks` and
 * for the inspection doctor shows alike. Both go through one reader (`readHookFile`) and one
 * judgement per kind (`judgeAgentHooks`, `judgeGitHook`); `setup hooks` writes from the same read.
 *
 * 1. Any content is read without throwing: absent, empty (read as `{}`), not JSON, the wrong shape
 *    at any depth (a command that isn't text included), a link, a folder, a file that can't be
 *    opened.
 * 2. Neuve judges and rewrites only entries that carry its marker (or the two older forms
 *    `isOwnCommand` names). Every other entry, group and field is kept as it is; a group is dropped
 *    only when it held a Neuve entry and nothing is left in it.
 * 3. A file Neuve shares with the person (an agent's hook file, a Git hook that isn't Neuve's) that
 *    it can't parse or mustn't touch is never rewritten: `setup hooks` stops on it and doctor
 *    reports it in the same words, with "fix or move the file". Neuve's own capture.json may be
 *    written again.
 * 4. Each part's state means one thing everywhere (`CapturePart`): ok, needs an update, missing, or
 *    unreadable. An entry Neuve can't read surely is ok with a note.
 * 5. Reading changes nothing; only `setup hooks` writes, after a backup of the file it changes.
 *
 * A known limit: an agent that changes its hook file between `setup hooks`'s read and its rename
 * loses that change (the backup keeps the file as it was read). Which install an entry runs, a link
 * in place of a Git hook (it becomes a plain file), a version marker on entries and a trailer hook
 * to remove are left for later.
 */

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
export const gitHookScript = (
  name: string,
  command: string,
  chained: boolean,
) => {
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

/**
 * The refusals `setup hooks` stops on, in the words doctor reports them with: each names what is
 * in the way, and Neuve changes nothing there until the person moves or fixes it.
 */
const refusal = {
  hooksFolderLink: (directory: string) =>
    `${directory} is a symbolic link; point core.hooksPath at a real directory`,
  notAPlainFile: (path: string) =>
    `${path} isn't a plain file or a link, so Neuve leaves it as it is; move it away first`,
  foreignBeside: (path: string, previous: string) =>
    `${path} is not Neuve's and ${previous} already exists; move one aside first`,
};

type GitHookState =
  | { readonly state: "ok" }
  | { readonly state: "update"; readonly why: string }
  | {
      readonly state: "missing";
      readonly why: string;
      readonly foreign: boolean;
    }
  | { readonly state: "unreadable"; readonly why: string };

/**
 * One Git hook against the one `command` would have: the judgement `setup hooks` acts on and doctor
 * reports. A folder in its place, or another tool's hook beside an earlier `.pre-neuve`, is refused.
 */
const judgeGitHook = async (
  hooksDirectory: string,
  name: string,
  command: string,
): Promise<GitHookState> => {
  const path = join(hooksDirectory, name);
  const previous = join(hooksDirectory, `${name}.pre-neuve`);
  const entry = await lstat(path).catch(() => undefined);
  if (entry === undefined)
    return { state: "missing", why: "there is no hook", foreign: false };
  if (
    !entry.isFile() &&
    !(
      entry.isSymbolicLink() &&
      (await stat(path).catch(() => undefined))?.isFile()
    )
  )
    return { state: "unreadable", why: refusal.notAPlainFile(path) };
  const current = await readFile(path, "utf8").catch(() => "");
  const chained = await exists(previous);
  if (!current.includes(MARKER))
    return chained
      ? { state: "unreadable", why: refusal.foreignBeside(path, previous) }
      : {
          state: "missing",
          why: "the hook there isn't Neuve's",
          foreign: true,
        };
  if (current !== gitHookScript(name, command, chained))
    return { state: "update", why: "it isn't the hook this setup writes" };
  if (!(await executableByOwner(path)))
    return { state: "update", why: "it can't be executed, so Git skips it" };
  return { state: "ok" };
};

const installGitHook = async (
  hooksDirectory: string,
  name: string,
  command: string,
  dryRun: boolean,
): Promise<Change> => {
  const path = join(hooksDirectory, name);
  const previous = join(hooksDirectory, `${name}.pre-neuve`);
  const judged = await judgeGitHook(hooksDirectory, name, command);
  if (judged.state === "unreadable") throw new Error(judged.why);
  if (judged.state === "ok") return { path, action: "unchanged" };
  let action = judged.state === "update" ? "updated" : "installed";
  if (judged.state === "missing" && judged.foreign) {
    if (!dryRun) await rename(path, previous);
    action = `installed; the existing hook moved to ${previous} and still runs first whenever it is executable`;
  }
  const chained =
    (judged.state === "missing" && judged.foreign) || (await exists(previous));
  if (!dryRun) {
    await mkdir(hooksDirectory, { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, gitHookScript(name, command, chained));
    await chmod(temporary, 0o755);
    await rename(temporary, path);
  }
  return { path, action: dryRun ? `would be ${action}` : action };
};

/**
 * The shape of an agent's hook file that Neuve relies on, the one parse both `setup hooks` and the
 * inspection read it with: events mapping to lists of groups, each group's `hooks` a list of entries
 * whose `command`, when there is one, is text. Everything else, at any depth, is kept as it is.
 */
const HookFile = z.looseObject({
  hooks: z
    .record(
      z.string(),
      z.array(
        z.looseObject({
          hooks: z
            .array(z.looseObject({ command: z.string().optional() }))
            .optional(),
        }),
      ),
    )
    .optional(),
});
type HookFile = z.infer<typeof HookFile>;
type HookGroup = NonNullable<HookFile["hooks"]>[string][number];

type HookFileRead =
  | { readonly kind: "absent" }
  | {
      readonly kind: "read";
      readonly text: string;
      /** Checked against `HookFile`, which puts the keys it knows first: for judging only. */
      readonly file: HookFile;
      /** The file as written, keys in the person's order: what a rewrite is built from. */
      readonly raw: Record<string, unknown>;
    }
  | { readonly kind: "unreadable"; readonly reason: string };

/** An agent's hook file through `HookFile`: absent, read, or unreadable with the reason. */
const readHookFile = async (path: string): Promise<HookFileRead> => {
  let text: string;
  try {
    // Only a plain file is read: a FIFO or a device would block the read for ever.
    const target = await linkTarget(path);
    const entry = await stat(target);
    if (!entry.isFile())
      return { kind: "unreadable", reason: "it isn't a plain file" };
    text = await readFile(target, "utf8");
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "ENOENT"
      ? { kind: "absent" }
      : {
          kind: "unreadable",
          reason: error instanceof Error ? error.message : String(error),
        };
  }
  // An empty file is a file with nothing in it yet.
  if (text.trim() === "") return { kind: "read", text, file: {}, raw: {} };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { kind: "unreadable", reason: "it isn't JSON" };
  }
  const parsed = HookFile.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      kind: "unreadable",
      reason: `${issue?.path.length ? issue.path.join(".") : "the file"}: ${issue?.message ?? "not a hook file"}`,
    };
  }
  return {
    kind: "read",
    text,
    file: parsed.data,
    raw: value as Record<string, unknown>,
  };
};

/**
 * Removes Neuve's entries from one event's groups. A group that held one and is left empty goes with
 * it; every other group, a person's group with no `hooks` or an empty list included, stays as it is.
 */
const withoutOwn = (groups: ReadonlyArray<HookGroup>) =>
  groups.flatMap((group) => {
    const hooks = group.hooks ?? [];
    if (!hooks.some((hook) => isOwnCommand(hook.command ?? ""))) return [group];
    const kept = hooks.filter((hook) => !isOwnCommand(hook.command ?? ""));
    return kept.length > 0 ? [{ ...group, hooks: kept }] : [];
  });

/** The line inside an entry Neuve wrote: what it runs, for which agent, on which event. */
const OWN_LINE =
  /^(.*) (claude-code|codex) ([a-z-]+) >\/dev\/null 2>&1; exit 0 # neuve-capture-hook$/s;

const unwrapped = (command: string) =>
  /^sh -c '(.*)'$/s.exec(command)?.[1]?.replaceAll(`'\\''`, "'");

type AgentHooksState =
  | { readonly state: "missing" }
  | { readonly state: "update"; readonly why: string }
  | {
      readonly state: "ok";
      /** Something Neuve couldn't judge, said beside the ok. */
      readonly note?: string;
      /** Each entry runs `prefix`, when one was given. */
      readonly sameInstall: boolean;
    };

/**
 * Neuve's entries for one agent in a parsed hook file, against what `setup hooks` writes: one entry
 * per event, under the event's own verb, with Neuve's command form, timeout and matcher, running
 * files that are there. The one judgement `setup hooks` reports from and doctor shows. Which install
 * an entry runs is not judged; `sameInstall` only says whether it is `prefix`.
 */
const judgeAgentHooks = async (
  file: HookFile,
  harness: AgentHarness,
  prefix?: string,
): Promise<AgentHooksState> => {
  const own = Object.entries(file.hooks ?? {}).flatMap(([event, groups]) =>
    groups.flatMap((group) =>
      (group.hooks ?? [])
        .filter((hook) => isOwnCommand(hook.command ?? ""))
        .map((hook) => ({ event, group, hook })),
    ),
  );
  if (own.length === 0) return { state: "missing" };
  const differs: string[] = [];
  const gone = new Set<string>();
  let unread = 0;
  let sameInstall = true;
  for (const [event] of AGENT_EVENTS) {
    const count = own.filter((entry) => entry.event === event).length;
    if (count === 0) differs.push(`its ${event} hook is missing`);
    if (count > 1) differs.push(`${event} has ${count} Neuve hooks`);
  }
  const matcher = harness === "codex" ? null : "";
  for (const { event, group, hook } of own) {
    const verb = AGENT_EVENTS.find(([name]) => name === event)?.[1];
    if (verb === undefined) differs.push(`a Neuve hook sits under ${event}`);
    const line = OWN_LINE.exec(unwrapped(hook.command!) ?? "");
    // Marked but not in Neuve's form is a command someone changed; unmarked, an older Neuve's form.
    if (line === null) {
      differs.push(
        hook.command!.includes(COMMAND_MARKER)
          ? `its ${event} hook's command was changed`
          : `its ${event} hook is in an older form`,
      );
      continue;
    }
    const [, runs, agent, said] = line as unknown as [
      string,
      string,
      string,
      string,
    ];
    if (agent !== harness || (verb !== undefined && said !== verb))
      differs.push(`its ${event} hook runs ${agent} ${said}`);
    else if (hook.command !== agentHookCommand(runs, agent, said))
      differs.push(`its ${event} hook's command was changed`);
    if (prefix !== undefined && runs !== prefix) sameInstall = false;
    const fields = hook as Record<string, unknown>;
    if (
      fields["type"] !== "command" ||
      fields["timeout"] !== HOOK_TIMEOUT_SECONDS
    )
      differs.push(`its ${event} hook's type or timeout was changed`);
    if (group["matcher"] !== matcher || (group.hooks ?? []).length !== 1)
      differs.push(`its ${event} hook's group was changed`);
    const files = filesCalledBy(hook.command!);
    if (files === undefined) unread += 1;
    else
      for (const needed of files)
        if (!(await present(needed))) gone.add(needed.path);
  }
  if (gone.size > 0)
    differs.unshift(
      `Neuve's ${harness} hooks run ${[...gone].join(", ")}, which isn't there or can't run, so they capture nothing`,
    );
  if (differs.length > 0)
    return { state: "update", why: [...new Set(differs)].join("; ") };
  return {
    state: "ok",
    sameInstall,
    ...(unread === 0
      ? {}
      : {
          note: `Neuve can't tell what ${unread} of its ${harness} hook entries run, so it can't say whether they work`,
        }),
  };
};

const installAgentHooks = async (
  path: string,
  harness: AgentHarness,
  command: string,
  dryRun: boolean,
): Promise<Change> => {
  // A file of a shape this can't change safely stops here, in the words doctor uses. The file is
  // read once; what is written is built from that read, so a file changed since can't make it throw.
  const read = await readHookFile(path);
  if (read.kind === "unreadable")
    throw new Error(unreadableHookFile(path, harness, read.reason));
  path = await linkTarget(path);
  const present = read.kind === "read";
  // Built from the file as written, so the person's keys, groups and entries keep their order;
  // the schema has already said every value here is of the shape it relies on.
  const config = present ? read.raw : {};
  const hooks = {
    ...((config["hooks"] ?? {}) as Record<string, HookGroup[]>),
  };
  // Neuve's entries under an event it doesn't write are taken out too; an event left with nothing
  // that was only Neuve's goes with them.
  for (const [event, groups] of Object.entries(hooks))
    if (!AGENT_EVENTS.some(([name]) => name === event)) {
      const kept = withoutOwn(groups);
      if (kept.length === 0 && groups.length > 0) delete hooks[event];
      else hooks[event] = kept;
    }
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
  const built = { ...config, hooks };
  const next = `${JSON.stringify(built, null, 2)}\n`;
  // As it should be, whatever its layout: the same keys in the same order. Nothing is written.
  if (present && JSON.stringify(built) === JSON.stringify(read.raw))
    return { path, action: "unchanged" };
  // Neuve's entries already right and only their place or layout differs: said as that.
  const judged = present
    ? await judgeAgentHooks(read.file, harness, command)
    : ({ state: "missing" } as const);
  const reordered = judged.state === "ok" && judged.sameInstall;
  if (dryRun)
    return {
      path,
      action: reordered
        ? "would reorder"
        : present
          ? "would update"
          : "would create",
    };
  const backup = await replaceFile(path, next);
  return {
    path,
    action:
      backup === undefined
        ? `created with ${AGENT_EVENTS.length} ${harness} hooks`
        : reordered
          ? `reordered: Neuve's ${harness} hooks were already right, and now come after the others (other settings kept); backup ${backup}`
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
    throw new Error(refusal.hooksFolderLink(hooksDirectory));

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
  const notFound: Array<{ mark: Mark; label: string; text: string }> = [];
  const agents =
    agentsFlag(values.agents) ??
    (await (async () => {
      const earlier = await readCaptureConfig(location);
      if (earlier === undefined && (await exists(captureConfigPath(location))))
        notFound.push({
          mark: "needs",
          label: "Capture",
          text: `${shown(captureConfigPath(location))} couldn't be read, so no earlier list of agents was kept; it is written again`,
        });
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
          notFound.push({
            mark: "done",
            label: finding.program.name,
            text: `${missingText(finding)}; its capture is already set up, so it is kept (--agents names the agents to keep)`,
          });
        } else
          notFound.push({
            mark: "skipped",
            label: finding.program.name,
            text: `${missingText(finding)}; no hooks written: ${installAdvice(finding)}, or name it with --agents`,
          });
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

  const screen = commandScreen({});
  await screen.header(`neuve setup hooks ${CLI_VERSION}`);
  const mark: Mark = dryRun ? "skipped" : "done";
  await screen.step(
    mark,
    "Capture",
    `${dryRun ? "dry run: would enable" : "enabled"} in ${shown(root)}; hooks run ${command}`,
  );
  await screen.detail(
    changes.map((change) => `${change.action}  ${shown(change.path)}`),
  );
  for (const line of notFound)
    await screen.step(line.mark, line.label, line.text);
  if (agents.includes("codex"))
    await screen.detail([
      "Codex asks you to review and trust new hooks the next time it starts.",
    ]);
  // Stack sources (11.15): their own lines, so what is fetched and its caps are named.
  const [first = "", ...rest] = await setupStack({
    root,
    dryRun,
    ...(values["no-stack"] === true ? { off: "--no-stack" as const } : {}),
    ...(options.stackStore === undefined
      ? {}
      : { storeRoot: options.stackStore }),
  });
  await screen.step(mark, "Stack sources", first);
  await screen.detail(rest.map((line) => line.trim()));
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
 * What one part of capture needs, read without writing, one meaning everywhere: `ok` (Neuve's own
 * and working, as far as Neuve can tell; `why` is then a note), `update` (Neuve's own, and setup
 * hooks would change it: it doesn't work, or is incomplete or malformed), `missing` (Neuve's part
 * isn't there) or `unreadable` (a file Neuve shares with the person that it can't parse or won't
 * touch; `why` is the sentence setup hooks stops with). There is no "needs removing" yet.
 */
export interface CapturePart {
  readonly path: string;
  readonly state: "ok" | "update" | "missing" | "unreadable";
  readonly why?: string;
}

/**
 * The files an agent hook entry needs, read back from the command `setup hooks` wrote: the program
 * it starts and, when that program is `bun` (a hook written from a source checkout), the script it
 * runs. Undefined when the command can't be read that surely: a bare or relative first word, or a
 * quoted one with an apostrophe in it. Such an entry is reported as one Neuve can't judge, never as
 * gone.
 */
const filesCalledBy = (command: string): ReadonlyArray<Needed> | undefined => {
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
  return neededBy(words);
};

/** A file a hook needs, and what for: the program it runs, or the script `bun` reads. */
interface Needed {
  readonly path: string;
  readonly use: "run" | "read";
}

/** From a hook's argv: the program, and when it is `bun`, the absolute script it runs. */
const neededBy = (argv: ReadonlyArray<string>): ReadonlyArray<Needed> => {
  const program: Needed = { path: argv[0]!, use: "run" };
  if (!/(^|\/)bun$/.test(program.path)) return [program];
  const script = argv.slice(1).find((word) => word.endsWith(".js"));
  return script !== undefined && isAbsolute(script)
    ? [program, { path: script, use: "read" }]
    : [program];
};

/** What setup hooks says, and doctor's fix, for an agent hook file it can't read. */
export const unreadableHookFile = (
  path: string,
  harness: AgentHarness,
  reason: string,
) =>
  `${path} can't be read as ${harness}'s hook file (${reason}), so Neuve leaves it as it is. Fix it or move it away, then run neuve setup hooks again.`;

/** A file an entry needs is there: the program runnable, a script readable. */
const present = async ({ path, use }: Needed) => {
  try {
    if (!(await stat(path)).isFile()) return false;
    await access(path, use === "read" ? constants.R_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

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
    command = config.hookCommand.map(quote).join(" ");
    // The program, and for a hook from a source checkout the bundled script `bun` runs.
    const needed = neededBy(config.hookCommand);
    const missing: string[] = [];
    for (const file of needed)
      if (!(await present(file))) missing.push(file.path);
    const program = missing.join(", ");
    dead = missing.length > 0;
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
    if (
      hooksDirectory !== undefined &&
      (await lstat(hooksDirectory).catch(() => undefined))?.isSymbolicLink()
    )
      parts.push({
        path: hooksDirectory,
        state: "unreadable",
        why: refusal.hooksFolderLink(hooksDirectory),
      });
    else
      for (const name of hooksDirectory === undefined ? [] : config.gitHooks) {
        const path = join(hooksDirectory!, name);
        const judged = await judgeGitHook(hooksDirectory!, name, command);
        parts.push(
          judged.state === "ok" && dead
            ? {
                path,
                state: "update",
                why: `it runs ${program}, which isn't there or can't run`,
              }
            : judged.state === "ok"
              ? { path, state: "ok" }
              : { path, state: judged.state, why: judged.why },
        );
      }
  }
  for (const harness of Identity.AGENT_HARNESSES) {
    const path = hookFiles(harness);
    const read = await readHookFile(path);
    if (read.kind === "unreadable") {
      parts.push({
        path,
        state: "unreadable",
        why: unreadableHookFile(path, harness, read.reason),
      });
      continue;
    }
    const judged =
      read.kind === "read"
        ? await judgeAgentHooks(read.file, harness)
        : ({ state: "missing" } as const);
    if (judged.state === "missing") {
      if (config?.agents.includes(harness) === true)
        parts.push({
          path,
          state: "missing",
          why: `there are no Neuve ${harness} hooks`,
        });
    } else if (judged.state === "update")
      parts.push({ path, state: "update", why: judged.why });
    else
      parts.push({
        path,
        state: "ok",
        ...(judged.note === undefined ? {} : { why: judged.note }),
      });
  }
  return { configured: config !== undefined, parts };
};
