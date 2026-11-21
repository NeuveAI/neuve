import { randomUUID } from "node:crypto";
import { existsSync, readSync, realpathSync } from "node:fs";
import {
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { PacketView } from "@neuve/harness";
import {
  AGENT_IDS,
  agentsFlag,
  describeFinding,
  findAgentPrograms,
  AGENT_PROGRAMS,
  installAdvice,
  programNamed,
  type Finding,
} from "./agent-programs.ts";
import type { AgentHarness } from "./capture/agent-hooks.ts";
import { CLI_VERSION } from "./cli-version.ts";
import {
  SKILL_NAME,
  lstatIfPresent,
  readSharedSkill,
  readSkillTemplate,
  requireRealFolders,
  sha256Of,
  skillPathSchema,
  versionSchema,
  writeFileAtomically,
  type SkillBundle,
} from "./skill-bundle.ts";

/**
 * `neuve skills`: installs the `neuve` agent skill into the skill folders of the agent programs
 * found ([the one list](agent-programs.ts)), or of those `--agents` names.
 *
 *   user scope (default)  Claude Code  ~/.claude/skills/neuve/ ($CLAUDE_CONFIG_DIR/skills/neuve/)
 *                         Codex        ~/.agents/skills/neuve/
 *   repo scope            Claude Code  <repo>/.claude/skills/neuve/
 *                         Codex        <repo>/.agents/skills/neuve/
 *
 * It writes only inside a `neuve/` folder it owns: the receipt there (`.neuve-skill.json`) names
 * the version and each file's SHA-256, and only those files are ever replaced or removed. A
 * `neuve/` folder with no receipt is someone else's and is refused untouched. Every file is written
 * atomically, and the receipt names a file before it is written, so an interrupted install is
 * finished by the next one. Nothing here edits agent settings, hooks, CLAUDE.md or AGENTS.md.
 *
 * Links: `neuve/` and every folder and file inside it must be real, never a link, or the command
 * refuses and changes nothing; this is checked before every read, write and removal. Above
 * `neuve/`, the user scope follows links on purpose (dotfile setups link ~/.claude, ~/.agents or
 * their skills folders), while the repo scope requires every folder from the repository down to
 * `neuve/` to be a real folder inside it, so a link committed in a repository can't send Neuve's
 * files anywhere else.
 */
export const RECEIPT = ".neuve-skill.json";

export type Agent = AgentHarness;
export type Scope = "user" | "repo";
const agentName = (agent: Agent) => programNamed(agent).name;

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
export const receiptSchema = z.strictObject({
  schemaVersion: z.literal(1),
  skill: z.literal(SKILL_NAME),
  /** Checked like the manifest's: a receipt in a repository is the repository's text. */
  version: versionSchema,
  /** False while an install or update is writing; the files it names may hold either side. */
  complete: z.boolean(),
  installedAt: z.string(),
  /** A path may appear twice while an update writes: either SHA-256 is Neuve's. */
  files: z
    .array(z.strictObject({ path: skillPathSchema, sha256: sha256Schema }))
    .refine(
      (files) => {
        // Two paths that differ only in case are one file on a case-insensitive volume.
        const seen = new Map<string, string>();
        for (const { path } of files) {
          const other = seen.get(path.toLowerCase());
          if (other !== undefined && other !== path) return false;
          seen.set(path.toLowerCase(), path);
        }
        return true;
      },
      { message: "two paths differ only in case" },
    ),
});
export type Receipt = z.infer<typeof receiptSchema>;

/** What `neuve skills` reads from its surroundings; tests pass their own. */
export type SkillsContext = Readonly<{
  home: string;
  /** Claude Code's configuration folder when `CLAUDE_CONFIG_DIR` names one. */
  claudeConfigDir: string | undefined;
  cwd: string;
  /** This CLI's version. */
  version: string;
  /** The skill this CLI carries, or the places it looked. */
  source: () => Promise<SkillSource>;
  /** The agent programs on this machine, for an install that names none (`--agents`). */
  programs: () => Promise<ReadonlyArray<Finding>>;
  /** Whether a person can answer a question: standard input and output are a terminal. */
  isTerminal: boolean;
  /** Prints the question and reads one line; null at the end of input. */
  ask: (question: string) => Promise<string | null>;
  out: (text: string) => Promise<void>;
  now: () => Date;
}>;

export type SkillSource =
  | Readonly<{ found: true; location: string; bundle: SkillBundle }>
  | Readonly<{ found: false; looked: ReadonlyArray<string> }>;

/**
 * The skill beside this CLI, found from the binary's real path like the Graph engine: an installed
 * or released copy (`<prefix>/bin/neuve` with `<prefix>/share/neuve/skills/`), then a workspace
 * build (`apps/neuve-cli/dist/neuve` with `apps/neuve-cli/skills/neuve/`), then, run from source,
 * the template beside this file. A shared copy that fails its manifest is an error, never skipped.
 */
export const findSkillSource = async (
  input: Readonly<{
    executable?: string;
    compiled?: boolean;
    version?: string;
  }> = {},
): Promise<SkillSource> => {
  const version = input.version ?? CLI_VERSION;
  const compiled = input.compiled ?? Bun.main.startsWith("/$bunfs/");
  const looked: Array<string> = [];
  if (compiled) {
    const executable = realpathSync(input.executable ?? process.execPath);
    const share = resolve(dirname(executable), "../share/neuve/skills");
    looked.push(share);
    if (existsSync(join(share, "manifest.json")))
      return {
        found: true,
        location: join(share, SKILL_NAME),
        bundle: await readSharedSkill(share),
      };
    const workspace = resolve(dirname(executable), "../skills/neuve");
    looked.push(workspace);
    if (existsSync(join(workspace, "SKILL.md")))
      return {
        found: true,
        location: workspace,
        bundle: await readSkillTemplate(workspace, version),
      };
  } else {
    const template = resolve(import.meta.dir, "../skills/neuve");
    looked.push(template);
    if (existsSync(join(template, "SKILL.md")))
      return {
        found: true,
        location: template,
        bundle: await readSkillTemplate(template, version),
      };
  }
  return { found: false, looked };
};

/**
 * One line from standard input, read with blocking reads of fd 0. Bun's own stdin stream watches
 * the descriptor with kqueue, which macOS refuses for /dev/tty (EINVAL), and the installer points
 * the offer's input at /dev/tty so it can ask even when it was piped in from curl.
 */
const readLine = async (question: string) => {
  await Bun.write(Bun.stdout, question);
  const bytes: Array<number> = [];
  const byte = new Uint8Array(1);
  let ended = false;
  for (;;) {
    let read: number;
    try {
      read = readSync(0, byte, 0, 1, null);
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "EAGAIN"
      ) {
        Bun.sleepSync(20);
        continue;
      }
      throw error;
    }
    if (read === 0) {
      ended = true;
      break;
    }
    if (byte[0] === 0x0a) break;
    bytes.push(byte[0] ?? 0);
  }
  // The end of input with nothing typed is no answer at all.
  if (ended && bytes.length === 0) return null;
  return new TextDecoder().decode(new Uint8Array(bytes)).replace(/\r$/, "");
};

export const defaultSkillsContext = (): SkillsContext => {
  const configured = process.env["CLAUDE_CONFIG_DIR"];
  return {
    home: homedir(),
    claudeConfigDir:
      configured !== undefined && configured !== "" ? configured : undefined,
    cwd: process.cwd(),
    version: CLI_VERSION,
    source: () => findSkillSource(),
    programs: () => findAgentPrograms("check"),
    isTerminal: process.stdin.isTTY === true && process.stdout.isTTY === true,
    ask: readLine,
    out: async (text) => {
      await Bun.write(Bun.stdout, text);
    },
    now: () => new Date(),
  };
};

export type Target = Readonly<{
  agent: Agent;
  scope: Scope;
  folder: string;
  /** In the repo scope, the repository: every folder from it down to `folder` must be real. */
  within?: string;
}>;

/** The `neuve/` folder each agent reads its skills from, in this scope. */
export const skillFolder = (
  context: Pick<SkillsContext, "home" | "claudeConfigDir">,
  agent: Agent,
  scope: Scope,
  repository?: string,
) => {
  if (scope === "repo") {
    if (repository === undefined)
      throw new Error("The repo scope needs a repository.");
    return join(
      repository,
      agent === "claude-code" ? ".claude" : ".agents",
      "skills",
      SKILL_NAME,
    );
  }
  return agent === "claude-code"
    ? join(
        context.claudeConfigDir ?? join(context.home, ".claude"),
        "skills",
        SKILL_NAME,
      )
    : join(context.home, ".agents", "skills", SKILL_NAME);
};

const label = (target: Target) =>
  `${agentName(target.agent)} (${target.scope === "user" ? "user" : "repository"})`;

/**
 * In the repo scope, refuses unless every folder from the repository down to `neuve/` that exists
 * is a real folder (not a link) whose real path is inside the repository. The user scope checks
 * nothing above `neuve/`: links there are the person's own setup.
 */
const requireFolderInside = async (target: Target) => {
  if (target.within === undefined) return;
  const path = relative(target.within, target.folder);
  if (path === "" || path.startsWith("..") || isAbsolute(path))
    throw new Error(`${target.folder} is not inside ${target.within}.`);
  await requireRealFolders(target.within, `${path}/${RECEIPT}`);
  let deepest = target.folder;
  while ((await lstatIfPresent(deepest)) === null) deepest = dirname(deepest);
  const real = await realpath(deepest);
  if (real !== target.within && !real.startsWith(`${target.within}/`))
    throw new Error(
      `${deepest} resolves to ${real}, outside ${target.within}.`,
    );
};

/**
 * Refuses a path inside `neuve/` unless `neuve/` itself is a real folder (or absent), the path is
 * a plain relative path, and every folder on its way is a real folder; in the repo scope, every
 * folder from the repository down to `neuve/` too. Checked before anything there is read, written
 * or removed, each time, so the window between a check and its use is one call wide.
 */
const requireOwnedPath = async (target: Target, path: string) => {
  const { folder } = target;
  await requireFolderInside(target);
  const stats = await lstatIfPresent(folder);
  if (stats !== null && (stats.isSymbolicLink() || !stats.isDirectory()))
    throw new Error(
      `${folder} is ${stats.isSymbolicLink() ? "a symbolic link" : "not a folder"}; move it away and rerun.`,
    );
  if (path !== RECEIPT && !skillPathSchema.safeParse(path).success)
    throw new Error(`${JSON.stringify(path)} is not a path inside ${folder}.`);
  await requireRealFolders(folder, path);
};

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

type FolderState =
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "empty" }>
  | Readonly<{ kind: "foreign"; reason: string }>
  | Readonly<{ kind: "ours"; receipt: Receipt }>;

const inspectFolder = async (folder: string): Promise<FolderState> => {
  const stats = await lstatIfPresent(folder);
  if (stats === null) return { kind: "absent" };
  if (stats.isSymbolicLink())
    return { kind: "foreign", reason: "it is a symbolic link" };
  if (!stats.isDirectory())
    return { kind: "foreign", reason: "it is not a folder" };
  if ((await readdir(folder)).length === 0) return { kind: "empty" };
  const receiptPath = join(folder, RECEIPT);
  const receiptStats = await lstatIfPresent(receiptPath);
  if (receiptStats === null)
    return {
      kind: "foreign",
      reason: `it has no ${RECEIPT}, so Neuve didn't write it`,
    };
  if (!receiptStats.isFile())
    return { kind: "foreign", reason: `its ${RECEIPT} is not a file` };
  try {
    return {
      kind: "ours",
      receipt: receiptSchema.parse(
        JSON.parse(await readFile(receiptPath, "utf8")),
      ),
    };
  } catch {
    return { kind: "foreign", reason: `its ${RECEIPT} can't be read` };
  }
};

/** A file's SHA-256, or what stands in its place (a link is never followed). */
const fileState = async (
  path: string,
): Promise<"absent" | "not a file" | string> => {
  const stats = await lstatIfPresent(path);
  if (stats === null) return "absent";
  if (!stats.isFile()) return "not a file";
  return sha256Of(new Uint8Array(await readFile(path)));
};

const shasByPath = (receipt: Receipt | undefined) => {
  const map = new Map<string, Set<string>>();
  for (const file of receipt?.files ?? []) {
    const set = map.get(file.path) ?? new Set<string>();
    set.add(file.sha256);
    map.set(file.path, set);
  }
  return map;
};

export type Step = Readonly<{
  path: string;
  /** The path inside `neuve/`, which is checked again before the step runs. */
  relative: string;
  /** For a removal: the SHA-256s the file may hold, checked again just before it is removed. */
  expected?: ReadonlyArray<string>;
  action: "create" | "replace" | "unchanged" | "remove";
}>;

export type TargetPlan = Readonly<{
  target: Target;
  refusals: ReadonlyArray<string>;
  steps: ReadonlyArray<Step>;
  receipt: Receipt | undefined;
  /** Installing would change nothing: the same version, every file in place. */
  current: boolean;
}>;

const refused = (target: Target, refusal: string): TargetPlan => ({
  target,
  refusals: [refusal],
  steps: [],
  receipt: undefined,
  current: false,
});

const NOT_A_FILE =
  "is a symbolic link or not a regular file; move it away and rerun.";

const planInstall = async (
  target: Target,
  bundle: SkillBundle,
): Promise<TargetPlan> => {
  try {
    await requireFolderInside(target);
  } catch (error) {
    return refused(target, message(error));
  }
  const state = await inspectFolder(target.folder);
  if (state.kind === "foreign")
    return {
      target,
      refusals: [
        `${target.folder} is not a folder Neuve wrote (${state.reason}). Nothing was changed there; move it away to install the skill.`,
      ],
      steps: [],
      receipt: undefined,
      current: false,
    };
  const receipt = state.kind === "ours" ? state.receipt : undefined;
  const known = shasByPath(receipt);
  const refusals: Array<string> = [];
  const steps: Array<Step> = [];
  for (const file of bundle.files) {
    const path = join(target.folder, file.path);
    const relative = file.path;
    try {
      await requireOwnedPath(target, relative);
    } catch (error) {
      refusals.push(message(error));
      continue;
    }
    const current = await fileState(path);
    if (current === "absent") steps.push({ path, relative, action: "create" });
    else if (current === "not a file") refusals.push(`${path} ${NOT_A_FILE}`);
    else if (current === file.sha256)
      steps.push({ path, relative, action: "unchanged" });
    else if (known.get(file.path)?.has(current) === true)
      steps.push({ path, relative, action: "replace" });
    else
      refusals.push(
        known.has(file.path)
          ? `${path} changed since Neuve installed it; move it away and rerun.`
          : `${path} wasn't written by Neuve; move it away and rerun.`,
      );
  }
  const incoming = new Set(bundle.files.map((file) => file.path));
  // A path the receipt names that differs only in case from one being installed is that file on a
  // case-insensitive volume: removing it would remove what was just written.
  const twins = new Map(
    bundle.files.map((file) => [file.path.toLowerCase(), file.path]),
  );
  for (const [relative, shas] of known) {
    if (incoming.has(relative)) continue;
    const path = join(target.folder, relative);
    try {
      await requireOwnedPath(target, relative);
    } catch (error) {
      refusals.push(message(error));
      continue;
    }
    const current = await fileState(path);
    if (current === "absent") continue;
    if (current === "not a file") refusals.push(`${path} ${NOT_A_FILE}`);
    else if (twins.has(relative.toLowerCase()))
      refusals.push(
        `${path} differs only in case from ${join(target.folder, twins.get(relative.toLowerCase())!)}, so they are one file here; move it away and rerun.`,
      );
    else if (shas.has(current))
      steps.push({ path, relative, action: "remove", expected: [...shas] });
    else
      refusals.push(
        `${path} changed since Neuve installed it; move it away and rerun.`,
      );
  }
  const current =
    receipt !== undefined &&
    receipt.complete &&
    receipt.version === bundle.version &&
    receipt.files.length === bundle.files.length &&
    steps.every((step) => step.action === "unchanged");
  return {
    target,
    refusals,
    steps: [
      ...steps,
      {
        path: join(target.folder, RECEIPT),
        relative: RECEIPT,
        action:
          receipt === undefined ? "create" : current ? "unchanged" : "replace",
      },
    ],
    receipt,
    current,
  };
};

const writeReceipt = async (
  target: Target,
  real: string,
  receipt: Omit<Receipt, "schemaVersion" | "skill">,
) =>
  writeOwnedFile(
    target,
    RECEIPT,
    real,
    `${JSON.stringify({ schemaVersion: 1, skill: SKILL_NAME, ...receipt } satisfies Receipt, null, 2)}\n`,
  );

/**
 * Removes the folders inside `neuve/` that the removals emptied, deepest first, each from inside
 * its parent after the same checks as a file (`atOwnedFile`), so a folder swapped for a link is
 * never followed. A folder that still holds something is left.
 */
const removeEmptyFolders = async (
  target: Target,
  real: string,
  paths: Iterable<string>,
) => {
  const folders = new Set<string>();
  for (const path of paths) {
    let folder = dirname(relative(target.folder, path));
    while (folder !== "." && folder !== "") {
      folders.add(folder);
      folder = dirname(folder);
    }
  }
  for (const folder of [...folders].sort((a, b) => b.length - a.length))
    await atOwnedFile(
      target,
      folder,
      real,
      () =>
        new Error(
          `${join(target.folder, folder)} changed while removing; nothing more was removed.`,
        ),
      async (name) => {
        const stats = await lstatIfPresent(name);
        if (stats === null || stats.isSymbolicLink() || !stats.isDirectory())
          return;
        await rmdir(name).catch(() => undefined);
      },
    );
};

/**
 * Runs `use` on one file inside `neuve/`, by its name, from inside its own folder. Every check
 * runs again first. Bun and Node have no `openat`, `renameat` or `unlinkat`, so the folder is held
 * as the process's working folder instead of a folder handle: the process enters it, checks that
 * its real path is the one under `neuve/`'s real path (`real`), and works by name from there. A
 * folder swapped for a link after that check is never followed, since the working folder is the
 * folder itself, not its path. Removing or renaming never follows the file itself.
 */
const atOwnedFile = async <A>(
  target: Target,
  relativePath: string,
  real: string,
  changed: () => Error,
  use: (name: string) => Promise<A>,
): Promise<A> => {
  await requireOwnedPath(target, relativePath);
  const folder = dirname(relativePath);
  const expected = folder === "." ? real : join(real, folder);
  const previous = process.cwd();
  process.chdir(join(target.folder, folder));
  try {
    if ((await realpath(".")) !== expected) throw changed();
    return await use(basename(relativePath));
  } finally {
    process.chdir(previous);
  }
};

/** Removes one file the plan named, when it still holds a SHA-256 the receipt names. */
const removeOwnedFile = (target: Target, step: Step, real: string) => {
  const changed = () =>
    new Error(`${step.path} changed while removing; nothing more was removed.`);
  return atOwnedFile(target, step.relative, real, changed, async (name) => {
    const stats = await lstatIfPresent(name);
    if (stats === null) return;
    if (!stats.isFile()) throw changed();
    if (
      step.expected !== undefined &&
      !step.expected.includes(sha256Of(new Uint8Array(await readFile(name))))
    )
      throw changed();
    await rm(name, { force: true });
  });
};

/** Writes one file inside `neuve/` atomically: a temporary file beside it, then a rename. */
const writeOwnedFile = (
  target: Target,
  relativePath: string,
  real: string,
  bytes: Uint8Array | string,
) =>
  atOwnedFile(
    target,
    relativePath,
    real,
    () =>
      new Error(
        `${join(target.folder, relativePath)} changed while installing; nothing more was written.`,
      ),
    async (name) => {
      const temporary = `.${SKILL_NAME}-${process.pid}-${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, bytes, { mode: 0o644 });
        await rename(temporary, name);
      } finally {
        await rm(temporary, { force: true });
      }
    },
  );

/** `neuve/`'s real path, once it is checked to be a real folder (and inside the repository). */
const realFolder = async (target: Target) => {
  await requireOwnedPath(target, RECEIPT);
  return realpath(target.folder);
};

const executeInstall = async (
  plan: TargetPlan,
  bundle: SkillBundle,
  now: Date,
) => {
  const { folder } = plan.target;
  await requireOwnedPath(plan.target, RECEIPT);
  await mkdir(folder, { recursive: true });
  // Again once the folders exist: one made a link since the plan is refused before any write.
  const real = await realFolder(plan.target);
  const stats = await lstatIfPresent(folder);
  if (stats === null || stats.isSymbolicLink() || !stats.isDirectory())
    throw new Error(
      `${folder} changed while installing; nothing more was written.`,
    );
  const incoming = bundle.files.map(({ path, sha256 }) => ({ path, sha256 }));
  const seen = new Set<string>();
  const interim = [...(plan.receipt?.files ?? []), ...incoming].filter(
    (file) => {
      const key = `${file.path}\0${file.sha256}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    },
  );
  // Named before the first file is written, so an interrupted install is this skill's to finish.
  await writeReceipt(plan.target, real, {
    version: bundle.version,
    complete: false,
    installedAt: now.toISOString(),
    files: interim,
  });
  const byPath = new Map(bundle.files.map((file) => [file.path, file]));
  const removed: Array<string> = [];
  for (const step of plan.steps) {
    const file = byPath.get(step.relative);
    if (
      file !== undefined &&
      (step.action === "create" || step.action === "replace")
    ) {
      // Its folder (references/) is made from inside neuve/, as the file is written from inside it.
      if (dirname(step.relative) !== ".")
        await atOwnedFile(
          plan.target,
          RECEIPT,
          real,
          () =>
            new Error(
              `${folder} changed while installing; nothing more was written.`,
            ),
          () => mkdir(dirname(step.relative), { recursive: true }),
        );
      await writeOwnedFile(plan.target, step.relative, real, file.bytes);
    } else if (step.action === "remove") {
      await removeOwnedFile(plan.target, step, real);
      removed.push(step.path);
    }
  }
  await removeEmptyFolders(plan.target, real, removed);
  await writeReceipt(plan.target, real, {
    version: bundle.version,
    complete: true,
    installedAt: now.toISOString(),
    files: incoming,
  });
};

const planUninstall = async (target: Target): Promise<TargetPlan> => {
  try {
    await requireFolderInside(target);
  } catch (error) {
    return refused(target, message(error));
  }
  const state = await inspectFolder(target.folder);
  if (state.kind === "foreign")
    return {
      target,
      refusals: [
        `${target.folder} is not a folder Neuve wrote (${state.reason}).`,
      ],
      steps: [],
      receipt: undefined,
      current: false,
    };
  if (state.kind !== "ours")
    return {
      target,
      refusals: [],
      steps: [],
      receipt: undefined,
      current: true,
    };
  const refusals: Array<string> = [];
  const steps: Array<Step> = [];
  for (const [relative, shas] of shasByPath(state.receipt)) {
    const path = join(target.folder, relative);
    try {
      await requireOwnedPath(target, relative);
    } catch (error) {
      refusals.push(message(error));
      continue;
    }
    const current = await fileState(path);
    if (current === "absent") continue;
    if (current === "not a file") refusals.push(`${path} ${NOT_A_FILE}`);
    else if (shas.has(current))
      steps.push({ path, relative, action: "remove", expected: [...shas] });
    else
      refusals.push(
        `${path} changed since Neuve installed it; move it away and rerun.`,
      );
  }
  return {
    target,
    refusals,
    steps: [
      ...steps,
      {
        path: join(target.folder, RECEIPT),
        relative: RECEIPT,
        action: "remove",
      },
    ],
    receipt: state.receipt,
    current: false,
  };
};

const executeUninstall = async (plan: TargetPlan) => {
  // `neuve/` itself, again: one swapped for a link since the plan is refused before any removal.
  const real = await realFolder(plan.target);
  const removed: Array<string> = [];
  for (const step of plan.steps)
    if (step.action === "remove" && step.relative !== RECEIPT) {
      await removeOwnedFile(plan.target, step, real);
      removed.push(step.path);
    }
  // The receipt goes last: an interrupted uninstall still names what is left.
  await removeOwnedFile(
    plan.target,
    {
      path: join(plan.target.folder, RECEIPT),
      relative: RECEIPT,
      action: "remove",
    },
    real,
  );
  await removeEmptyFolders(plan.target, real, removed);
  await rmdir(plan.target.folder).catch(() => undefined);
};

const describe = (plan: TargetPlan, verb: "install" | "uninstall") => {
  const lines = [`${label(plan.target)}: ${plan.target.folder}`];
  if (plan.refusals.length > 0) {
    lines.push(
      ...[...new Set(plan.refusals)].map(
        (refusal) => `  refused    ${refusal}`,
      ),
    );
    return lines;
  }
  if (verb === "install" && plan.current) {
    lines.push("  up to date");
    return lines;
  }
  if (verb === "uninstall" && plan.steps.length === 0) {
    lines.push("  not installed");
    return lines;
  }
  for (const step of plan.steps)
    lines.push(`  ${step.action.padEnd(9)}  ${step.path}`);
  return lines;
};

/** `--agents` for the skill: named programs, never none. Undefined when not given. */
const parseAgents = (value: string | undefined) => agentsFlag(value, false);

const gitTopLevel = async (path: string) => {
  const child = Bun.spawn(["git", "-C", path, "rev-parse", "--show-toplevel"], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  });
  const [stdout, code] = await Promise.all([
    new Response(child.stdout).text(),
    child.exited,
  ]);
  return code === 0 ? realpath(stdout.trim()) : undefined;
};

const repositoryFor = async (cwd: string, flag: string | undefined) => {
  const path = resolve(cwd, flag ?? ".");
  const repository = await gitTopLevel(path).catch(() => undefined);
  if (repository === undefined)
    throw new Error(
      `The repo scope needs a Git repository; ${path} is not in one.`,
    );
  return repository;
};

const targetsOf = async (
  context: SkillsContext,
  values: Readonly<{ agents?: string; scope?: string; repo?: string }>,
  /** For an install that names none: the programs found, and those whose skill is already here. */
  look = false,
): Promise<ReadonlyArray<Target>> => {
  const scope = values.scope ?? "user";
  if (scope !== "user" && scope !== "repo")
    throw new Error(
      `--scope takes user or repo, not ${JSON.stringify(scope)}.`,
    );
  if (scope === "user" && values.repo !== undefined)
    throw new Error("--repo goes with --scope repo.");
  const repository =
    scope === "repo"
      ? await repositoryFor(context.cwd, values.repo)
      : undefined;
  const agents =
    parseAgents(values.agents) ??
    (look
      ? await keptAgents(context, await context.programs(), scope, repository)
      : AGENT_IDS);
  return agents.map((agent) => ({
    agent,
    scope,
    folder: skillFolder(context, agent, scope, repository),
    ...(repository === undefined ? {} : { within: repository }),
  }));
};

/**
 * The agents a skill install covers when none is named: those found here, and every one whose
 * skill Neuve already installed in this scope, so a program not found never leaves its copy stale.
 * Each one not found is said so.
 */
const keptAgents = async (
  context: SkillsContext,
  findings: ReadonlyArray<Finding>,
  scope: Scope,
  repository?: string,
) => {
  const kept: Agent[] = [];
  for (const finding of findings) {
    const agent = finding.program.id;
    if (finding.found !== undefined) {
      kept.push(agent);
      continue;
    }
    const installed =
      (await inspectFolder(skillFolder(context, agent, scope, repository)))
        .kind === "ours";
    if (installed) kept.push(agent);
    await context.out(
      `${describeFinding(finding)}\n${
        installed
          ? `Its skill is already installed, so it is kept up to date.`
          : `Its skill is not installed: ${installAdvice(finding)}, or name it with --agents.`
      }\n`,
    );
  }
  return kept;
};

const requireSource = async (context: SkillsContext) => {
  const source = await context.source();
  if (!source.found)
    throw new Error(
      `The skill's files aren't beside this neuve (looked in ${source.looked.join(" and ")}). Reinstall Neuve.`,
    );
  return source;
};

const names = (plans: ReadonlyArray<TargetPlan>) =>
  [...new Set(plans.map((plan) => agentName(plan.target.agent)))].join(" and ");

const LATER = "To install the skill later, run neuve skills install.";

/** Plans and, unless refused or asked not to, installs; returns the exit code. */
const install = async (
  context: SkillsContext,
  targets: ReadonlyArray<Target>,
  mode: "install" | "dry-run" | "offer",
) => {
  const { bundle } = await requireSource(context);
  if (targets.length === 0) {
    await context.out(
      "No agent program was found, so the skill wasn't installed. Name one with --agents to install it anyway.\n",
    );
    return 0;
  }
  const plans = await Promise.all(
    targets.map((target) => planInstall(target, bundle)),
  );
  const refused = plans.some((plan) => plan.refusals.length > 0);
  const lines = [
    `The Neuve skill ${bundle.version}, which teaches an agent to use Neuve:`,
    ...plans.flatMap((plan) => describe(plan, "install")),
  ];
  await context.out(`${lines.join("\n")}\n`);
  if (refused) {
    await context.out("Nothing was installed.\n");
    // The offer runs at the end of another command and never fails it.
    return mode === "offer" ? 0 : 1;
  }
  if (plans.every((plan) => plan.current)) {
    await context.out(
      `The Neuve skill ${bundle.version} is already installed for ${names(plans)}.\n`,
    );
    return 0;
  }
  // Only the agents whose copy would change are named in the question and the result.
  const changing = plans.filter((plan) => !plan.current);
  if (mode === "dry-run") {
    await context.out("Dry run: nothing was written.\n");
    return 0;
  }
  if (mode === "offer") {
    if (!context.isTerminal) {
      await context.out(
        `Not installed: there is no terminal to ask. ${LATER}\n`,
      );
      return 0;
    }
    const answer = await context.ask(
      `Install the Neuve skill for ${names(changing)}? [y/N] `,
    );
    if (!/^\s*y(es)?\s*$/i.test(answer ?? "")) {
      await context.out(`Not installed. ${LATER}\n`);
      return 0;
    }
  }
  const now = context.now();
  for (const plan of changing) await executeInstall(plan, bundle, now);
  await context.out(
    `Installed the Neuve skill ${bundle.version} for ${names(changing)}. New agent sessions load it.\n`,
  );
  return 0;
};

const uninstall = async (
  context: SkillsContext,
  targets: ReadonlyArray<Target>,
  dryRun: boolean,
) => {
  const plans = await Promise.all(targets.map(planUninstall));
  await context.out(
    `${["The Neuve skill:", ...plans.flatMap((plan) => describe(plan, "uninstall"))].join("\n")}\n`,
  );
  if (plans.some((plan) => plan.refusals.length > 0)) {
    await context.out("Nothing was removed.\n");
    return 1;
  }
  const work = plans.filter((plan) => plan.steps.length > 0);
  if (work.length === 0) {
    await context.out("The Neuve skill is not installed there.\n");
    return 0;
  }
  if (dryRun) {
    await context.out("Dry run: nothing was removed.\n");
    return 0;
  }
  for (const plan of work) await executeUninstall(plan);
  await context.out(`Removed the Neuve skill for ${names(work)}.\n`);
  return 0;
};

export type InstalledSkill = Readonly<{
  target: Target;
  state: "not installed" | "foreign" | "unsafe" | "incomplete" | "installed";
  version?: string;
  reason?: string;
}>;

/** What each agent folder holds, for `list` and `neuve doctor`. */
export const inspectInstalled = async (
  context: Pick<SkillsContext, "home" | "claudeConfigDir">,
  repository?: string,
): Promise<ReadonlyArray<InstalledSkill>> => {
  const targets: Array<Target> = [];
  for (const scope of repository === undefined
    ? (["user"] as const)
    : (["user", "repo"] as const))
    for (const agent of AGENT_IDS)
      targets.push({
        agent,
        scope,
        folder: skillFolder(context, agent, scope, repository),
        ...(scope === "repo" && repository !== undefined
          ? { within: repository }
          : {}),
      });
  return Promise.all(
    targets.map(async (target): Promise<InstalledSkill> => {
      try {
        await requireFolderInside(target);
      } catch (error) {
        return { target, state: "foreign", reason: message(error) };
      }
      const state = await inspectFolder(target.folder);
      if (state.kind === "absent" || state.kind === "empty")
        return { target, state: "not installed" };
      if (state.kind === "foreign")
        return { target, state: "foreign", reason: state.reason };
      // A copy with a link inside it would be refused by install and uninstall: say so here too.
      for (const { path } of state.receipt.files)
        try {
          await requireOwnedPath(target, path);
        } catch (error) {
          return {
            target,
            state: "unsafe",
            version: state.receipt.version,
            reason: message(error),
          };
        }
      return {
        target,
        state: state.receipt.complete ? "installed" : "incomplete",
        version: state.receipt.version,
      };
    }),
  );
};

const older = (installed: string, cli: string) => {
  try {
    return Bun.semver.order(installed, cli) < 0;
  } catch {
    return installed !== cli;
  }
};

const statusText = (skill: InstalledSkill, cliVersion: string) => {
  if (skill.state === "not installed") return "not installed";
  if (skill.state === "foreign")
    return `a neuve folder Neuve didn't write (${skill.reason})`;
  if (skill.state === "unsafe")
    return `${skill.version}, not safe to update or remove: ${skill.reason}`;
  if (skill.state === "incomplete")
    return `${skill.version}, not finished installing: run neuve skills install`;
  return skill.version !== undefined && older(skill.version, cliVersion)
    ? `${skill.version}, older than this neuve's ${cliVersion}: run neuve skills install`
    : `${skill.version}`;
};

const list = async (context: SkillsContext, repo: string | undefined) => {
  const repository =
    repo !== undefined
      ? await repositoryFor(context.cwd, repo)
      : await gitTopLevel(context.cwd).catch(() => undefined);
  const source = await context.source();
  const installed = await inspectInstalled(context, repository);
  const width = Math.max(
    ...installed.map((skill) => label(skill.target).length),
  );
  await context.out(
    `${[
      source.found
        ? `This neuve carries the Neuve skill ${source.bundle.version} (${source.location}).`
        : `This neuve carries no skill files (looked in ${source.looked.join(" and ")}).`,
      ...installed.map(
        (skill) =>
          `  ${label(skill.target).padEnd(width)}  ${skill.target.folder}  ${statusText(skill, context.version)}`,
      ),
    ].join("\n")}\n`,
  );
  return 0;
};

/** One line for `neuve doctor`, shaped like its other checks. */
export type SkillCheck = Readonly<{
  check: string;
  status: "ok" | "missing" | "warning";
  detail: string;
  fix?: string;
}>;

/**
 * What `neuve skills` prints, with terminal escape sequences, control characters and
 * bidirectional overrides removed (`PacketView.terminalSafe`, the one definition the CLI uses for
 * stored text): a receipt or a path in a repository is the repository's text, never the terminal's.
 */
const guarded = (context: SkillsContext): SkillsContext => ({
  ...context,
  out: (text) => context.out(PacketView.terminalSafe(text)),
  ask: (question) => context.ask(PacketView.terminalSafe(question)),
});

/**
 * Whether the installed skill is older than this CLI (or unfinished, or not safe to update), for
 * `neuve doctor`. An uninstalled skill is fine: it is optional. A skill folder that can't be read
 * (no permission, a file where a folder should be) is one warning naming it, never an error: the
 * check never stops doctor's other checks or changes its exit code.
 */
export const inspectSkillForDoctor = async (
  input: Parameters<typeof skillCheck>[0],
): Promise<SkillCheck> => {
  let check: SkillCheck;
  try {
    check = await skillCheck(input);
  } catch (error) {
    const path =
      error instanceof Error &&
      "path" in error &&
      typeof error.path === "string"
        ? error.path
        : undefined;
    check = {
      check: "agent skill",
      status: "warning",
      detail: `the Neuve skill's folder${path === undefined ? "s" : ` ${path}`} can't be read: ${message(error)}`,
      fix: "Make it readable, or move it away, then run neuve doctor again",
    };
  }
  return {
    ...check,
    detail: PacketView.terminalSafe(check.detail),
    ...(check.fix === undefined
      ? {}
      : { fix: PacketView.terminalSafe(check.fix) }),
  };
};

const skillCheck = async (
  input: Readonly<{
    home?: string;
    claudeConfigDir?: string | undefined;
    version?: string;
    repository?: string;
    /** Quotes a path for the shell (doctor's `shell-quote.ts`), for the repo scope's fix. */
    quote: (value: string) => string;
  }>,
): Promise<SkillCheck> => {
  const context = defaultSkillsContext();
  const home = input.home ?? context.home;
  const claudeConfigDir =
    "claudeConfigDir" in input
      ? input.claudeConfigDir
      : context.claudeConfigDir;
  const version = input.version ?? context.version;
  const installed = (
    await inspectInstalled({ home, claudeConfigDir }, input.repository)
  ).filter(
    (skill) =>
      skill.state === "installed" ||
      skill.state === "incomplete" ||
      skill.state === "unsafe",
  );
  const behind = installed.filter(
    (skill) =>
      skill.state !== "installed" ||
      (skill.version !== undefined && older(skill.version, version)),
  );
  if (behind.length > 0)
    return {
      check: "agent skill",
      status: "warning",
      detail: behind
        .map((skill) =>
          skill.state === "unsafe"
            ? `the Neuve skill for ${label(skill.target)} at ${skill.target.folder} is not safe to update or remove: ${skill.reason}`
            : skill.state === "incomplete"
              ? `the Neuve skill for ${label(skill.target)} at ${skill.target.folder} did not finish installing`
              : `the Neuve skill for ${label(skill.target)} at ${skill.target.folder} is ${skill.version}, older than this neuve's ${version}`,
        )
        .join("; "),
      fix: [
        ...new Set(
          behind.map((skill) =>
            skill.target.scope === "user"
              ? "neuve skills install"
              : `neuve skills install --scope repo --repo ${input.quote(skill.target.within ?? skill.target.folder)}`,
          ),
        ),
      ].join(" && "),
    };
  if (installed.length === 0)
    return {
      check: "agent skill",
      status: "ok",
      detail: `not installed. To teach ${AGENT_PROGRAMS.map((program) => program.name).join(" and ")} to use Neuve, run neuve skills install`,
    };
  return {
    check: "agent skill",
    status: "ok",
    detail: installed
      .map((skill) => `${skill.version} for ${label(skill.target)}`)
      .join(", "),
  };
};

/**
 * The offer at the end of `neuve setup`: once per repository (a marker in the folder setup keeps
 * the repository's state in), only when a person is at a terminal, for the user scope. It never
 * fails setup. When it can't be made for a reason another try wouldn't change, it says why.
 */
export const offerSkillsAfterSetup = async (
  input: Readonly<{
    /** Setup's folder for this repository's state, where the marker goes. */
    stateDirectory: string;
    /** The agent programs setup found; the skill is offered for those, and kept current wherever it is installed. */
    agents: ReadonlyArray<Agent>;
    context?: SkillsContext;
  }>,
): Promise<{ readonly reason?: string }> => {
  const context = guarded(input.context ?? defaultSkillsContext());
  if (!context.isTerminal) return {};
  const marker = join(input.stateDirectory, "skills-offered.json");
  try {
    if ((await lstatIfPresent(marker)) !== null) return {};
    const source = await context.source();
    if (!source.found)
      return { reason: "this neuve carries no Neuve skill to offer" };
    // A skill already installed is kept up to date even when setup didn't find its program.
    const installed = await keptAgents(
      { ...context, out: async () => {} },
      AGENT_PROGRAMS.filter(
        (program) => !input.agents.includes(program.id),
      ).map((program) => ({ program, lines: [], strangers: [] })),
      "user",
    );
    const agents = [...input.agents, ...installed];
    if (agents.length === 0)
      return { reason: "no agent program was found to offer it to" };
    await context.out("\n");
    await install(
      context,
      agents.map((agent) => ({
        agent,
        scope: "user" as const,
        folder: skillFolder(context, agent, "user"),
      })),
      "offer",
    );
    // Only an offer that was made is remembered; one that stopped on an error asks next time.
    await mkdir(dirname(marker), { recursive: true, mode: 0o700 });
    await writeFileAtomically(
      marker,
      `${JSON.stringify({ offeredAt: context.now().toISOString() })}\n`,
    );
    return {};
  } catch (error) {
    // It never fails setup, and is tried again next time.
    await context.out(`The skill offer stopped: ${message(error)}\n`);
    return {};
  }
};

export const SKILLS_HELP = `Usage:
  neuve skills list [--repo <path>]
              Show the Neuve skill this neuve carries and where it is installed for Claude
              Code and Codex.
  neuve skills install [--agents claude-code,codex] [--scope user|repo] [--repo <path>]
    [--dry-run] [--offer]
              Install the Neuve skill, which teaches an agent to set up Neuve, request a
              review, read what it says and record proof. The user scope (the default) writes
              ~/.claude/skills/neuve/ for Claude Code ($CLAUDE_CONFIG_DIR/skills/neuve/ when that
              is set) and ~/.agents/skills/neuve/ for Codex. The repo scope writes
              <repo>/.claude/skills/neuve/ and <repo>/.agents/skills/neuve/, for a team that keeps
              the skill with its code (--repo defaults to the current repository). Running it
              again updates the skill to this neuve's version. Without --agents it installs for
              the agent programs found here: claude on the PATH, and the Codex the codex
              account runs (asked its version, once), and says which were not found.
              It writes only inside those neuve/ folders, with a receipt (.neuve-skill.json) that
              names each file, and never changes agent settings, hooks, CLAUDE.md or AGENTS.md.
              A neuve/ folder Neuve didn't write is refused and left as it is.
              --dry-run  Print every file it would write, with its full path; write nothing.
              --offer    Print the same list and ask first (the default answer is no). Without
                         a terminal it writes nothing and says how to install later.
  neuve skills uninstall [--agents claude-code,codex] [--scope user|repo] [--repo <path>]
    [--dry-run]
              Remove the files the receipt names, and nothing else.`;

export const runSkillsCli = async (
  args: ReadonlyArray<string>,
  given: SkillsContext = defaultSkillsContext(),
): Promise<number> => {
  try {
    return await runCommand(args, guarded(given));
  } catch (error) {
    // A refusal can name a path from a repository; it leaves through the same filter as output.
    throw new Error(PacketView.terminalSafe(message(error)));
  }
};

const runCommand = async (
  args: ReadonlyArray<string>,
  context: SkillsContext,
): Promise<number> => {
  const [command, ...rest] = args;
  if (
    command === undefined ||
    command === "--help" ||
    command === "help" ||
    rest.includes("--help")
  ) {
    await context.out(`${SKILLS_HELP}\n`);
    return 0;
  }
  if (command === "list") {
    const { values } = parseArgs({
      args: [...rest],
      options: { repo: { type: "string" } },
      strict: true,
      allowPositionals: false,
    });
    return list(context, values.repo);
  }
  if (command === "install" || command === "uninstall") {
    const { values } = parseArgs({
      args: [...rest],
      options: {
        agents: { type: "string" },
        scope: { type: "string" },
        repo: { type: "string" },
        "dry-run": { type: "boolean" },
        offer: { type: "boolean" },
      },
      strict: true,
      allowPositionals: false,
    });
    if (command === "uninstall" && values.offer === true)
      throw new Error("--offer goes with neuve skills install.");
    const targets = await targetsOf(context, values, command === "install");
    if (command === "uninstall")
      return uninstall(context, targets, values["dry-run"] === true);
    if (values["dry-run"] === true && values.offer === true)
      throw new Error("--dry-run and --offer don't go together.");
    return install(
      context,
      targets,
      values["dry-run"] === true
        ? "dry-run"
        : values.offer === true
          ? "offer"
          : "install",
    );
  }
  throw new Error(
    `Unknown skills command: ${command}. Run neuve skills --help for usage.`,
  );
};
