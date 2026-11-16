import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { z } from "zod";
import { constants } from "node:fs";
import {
  access,
  lstat,
  link,
  mkdir,
  open,
  readdir,
  rename,
  realpath,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { AGENT_LABEL, SWEEP_INTERVAL_SECONDS } from "./launchd.ts";

export const SERVICE = `${AGENT_LABEL}.service`;
export const TIMER = `${AGENT_LABEL}.timer`;
export const NO_USER_SYSTEMD =
  "There's no user systemd here, so the timer that starts background workers wasn't set up. Run neuve worker start in a repository to start its worker.";
export const INSTALLED =
  "Installed the systemd timer that starts background workers at login and every 5 minutes. It runs only while you're logged in. To keep it running after you log out, run loginctl enable-linger. See its logs with journalctl --user -u dev.neuve.worker.";
export const UNSUPPORTED_EXECUTABLE =
  "The path to neuve contains quotes or backslashes, which some systemd versions can't run, so the systemd timer wasn't set up. Run neuve worker start in a repository to start its worker.";
export const FOREIGN =
  "The systemd timer dev.neuve.worker runs another command or has unsupported overrides, so it was left in place.";
export const UNSAFE =
  "Can't safely change the unit files for dev.neuve.worker or their folder, so they were left in place.";

// Match the installer's raw-path restrictions before path normalization can hide bytes.
const rawPath = (path: string) =>
  isAbsolute(path) &&
  !/[\x00-\x1f\x7f"\\|&:]/.test(path) &&
  !/(?:^|\/)\.{1,2}(?:\/|$)/.test(path);
export const agentUnitPaths = (
  home = homedir(),
  config = process.env.XDG_CONFIG_HOME,
) => {
  const directory = join(
    config && rawPath(config) ? config : join(home, ".config"),
    "systemd/user",
  );
  return {
    directory,
    service: join(directory, SERVICE),
    timer: join(directory, TIMER),
  };
};

const unsupportedExecutable = (command: string) => /["'\\]/.test(command);
const quoteExecutable = (command: string) => {
  if (unsupportedExecutable(command)) throw new Error(UNSUPPORTED_EXECUTABLE);
  if (!isAbsolute(command) || /[\x00-\x1f\x7f]/.test(command))
    throw new Error(
      "neuve must run from an absolute path without control characters.",
    );
  // systemd expands specifiers in the executable path, but not environment variables.
  // Its separately stored executable path must retain literal dollars, not doubled dollars.
  return `"${command.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%")}"`;
};

export const agentService = (command: string) => `[Unit]
Description=Neuve worker sweep
StartLimitIntervalSec=10min
StartLimitBurst=5

[Service]
Type=oneshot
# Detached on-demand workers must survive the sweep leaving this service cgroup.
KillMode=process
ExecStart=${quoteExecutable(command)} worker sweep
`;
export const agentTimer = () => `[Unit]
Description=Run the Neuve worker sweep every ${SWEEP_INTERVAL_SECONDS / 60} minutes

[Timer]
OnBootSec=1min
OnUnitActiveSec=${SWEEP_INTERVAL_SECONDS / 60}min

[Install]
WantedBy=timers.target
`;

// Deliberately refuse continuations and unknown escapes instead of guessing ownership.
const stripWhitespace = (value: string) =>
  value.replace(/^[ \t\n\r]+|[ \t\n\r]+$/g, "");
const unitEntries = (text: string) => {
  if (/[\r\0]/.test(text)) return null;
  let section = "";
  const entries: { section: string; key: string; value: string }[] = [];
  for (const raw of text.split("\n")) {
    const line = stripWhitespace(raw);
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    if (line.endsWith("\\")) return null;
    if (/^\[[^\[\]]+\]$/.test(line)) {
      section = line;
      continue;
    }
    const entry = /^([A-Za-z][A-Za-z0-9]*)[ \t\n\r]*=[ \t\n\r]*([^\n]*)$/.exec(
      line,
    );
    if (!section || !entry || entry[1] === undefined || entry[2] === undefined)
      return null;
    entries.push({ section, key: entry[1], value: entry[2] });
  }
  return entries;
};
const serviceCommand = (text: string): string | null => {
  const entries = unitEntries(text);
  const modes = entries?.filter((entry) => entry.key === "KillMode");
  if (
    modes?.length !== 1 ||
    modes[0]?.section !== "[Service]" ||
    modes[0].value !== "process"
  )
    return null;
  const starts = entries?.filter((entry) => entry.key === "ExecStart");
  if (!starts || starts.length !== 1 || starts[0]?.section !== "[Service]")
    return null;
  const exec = starts[0].value;
  if (!exec) return null;
  const words: string[] = [];
  const tokens =
    /(?:^|[ \t\n\r]+)("(?:[^"\\]|\\[\\"'])*"|'(?:[^'\\]|\\[\\"'])*'|[^ \t\n\r"'\\]+)(?=[ \t\n\r]|$)/gy;
  let end = 0;
  for (;;) {
    const match = tokens.exec(exec);
    if (!match) break;
    const token = match[1];
    if (!token) return null;
    const word =
      token.startsWith('"') || token.startsWith("'")
        ? token.slice(1, -1).replace(/\\([\\"'])/g, "$1")
        : token;
    if (/%(?!%)/.test(word.replaceAll("%%", ""))) return null;
    words.push(word.replaceAll("%%", "%"));
    end = tokens.lastIndex;
  }
  const command = words[0];
  return end === exec.length &&
    words.length === 3 &&
    command &&
    isAbsolute(command) &&
    !unsupportedExecutable(command) &&
    words[1] === "worker" &&
    words[2] === "sweep"
    ? command
    : null;
};

export const ownsService = (text: string, command: string) =>
  serviceCommand(text) === command;

// Only a complete Neuve service identifies a prefix. Arbitrary commands stay foreign.
export const agentOwnerPrefix = (text: string): string | null => {
  const command = serviceCommand(text);
  return command?.endsWith("/bin/neuve") ? command.slice(0, -10) || "/" : null;
};
export const otherOwnerMessage = (prefix: string) =>
  `The systemd timer dev.neuve.worker belongs to the neuve install in ${prefix}, so it was left in place.`;
// An owned service must never authorize starting a timer aimed at another service.
export const ownsTimer = (text: string) => {
  const entries = unitEntries(text);
  if (!entries) return false;
  const targets = entries.filter((entry) => entry.key === "Unit");
  if (
    targets.length > 1 ||
    targets.some(
      (entry) => entry.section !== "[Timer]" || entry.value !== SERVICE,
    )
  )
    return false;
  return entries.some(
    (entry) =>
      entry.section === "[Timer]" &&
      /^(OnActiveSec|OnBootSec|OnStartupSec|OnUnitActiveSec|OnUnitInactiveSec|OnCalendar)$/.test(
        entry.key,
      ) &&
      entry.value.length > 0,
  );
};

const missing = (error: unknown) =>
  error instanceof Error && "code" in error && error.code === "ENOENT";
const info = async (path: string) =>
  lstat(path).catch((error: unknown) => {
    if (missing(error)) return null;
    throw error;
  });
const safeParents = async (path: string) => {
  let directory = dirname(path);
  let found = false;
  for (;;) {
    const status = await info(directory);
    if (status) {
      if (!status.isDirectory() || status.isSymbolicLink()) return false;
      if (!found) {
        if (!(status.mode & 0o222)) return false;
        await access(directory, constants.W_OK);
        found = true;
      }
    }
    const parent = dirname(directory);
    if (parent === directory) return found;
    directory = parent;
  }
};
const safeFile = async (path: string) => {
  if (!(await safeParents(path))) return false;
  const status = await info(path);
  if (!status) return true;
  if (
    !status.isFile() ||
    status.isSymbolicLink() ||
    status.nlink !== 1 ||
    !(status.mode & 0o222)
  )
    return false;
  await access(path, constants.R_OK | constants.W_OK);
  return true;
};
const unitBytes = async (path: string) => {
  const status = await info(path);
  if (!status) return null;
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    if (!(await handle.stat()).isFile())
      throw new Error("A unit file for dev.neuve.worker isn't a plain file.");
    return await handle.readFile();
  } finally {
    await handle.close();
  }
};
const temporaryPrefix = (command: string) =>
  `.neuve-worker-${createHash("sha256").update(command).digest("hex")}-`;
const removeLeftovers = async (directory: string, command: string) => {
  for (const name of await readdir(directory).catch((error: unknown) => {
    if (missing(error)) return [];
    throw error;
  })) {
    if (
      !name.startsWith(temporaryPrefix(command)) ||
      !/^[0-9a-f-]{36}$/.test(name.slice(temporaryPrefix(command).length))
    )
      continue;
    const path = join(directory, name);
    const status = await info(path);
    if (status?.isFile() && !status.isSymbolicLink())
      await unlink(path).catch((error: unknown) => {
        if (!missing(error)) throw error;
      });
  }
};
// A complete claim is linked without replacing an existing destination. Complete
// unit bytes then replace that claim by rename, never by truncating the destination.
const putUnit = async (
  path: string,
  bytes: string | Uint8Array,
  command: string,
  claim = false,
  check: () => Promise<void> = async () => {},
): Promise<void> => {
  for (;;) {
    const temporary = join(
      dirname(path),
      temporaryPrefix(command) + randomUUID(),
    );
    const handle = await open(
      temporary,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o644,
    );
    let retry = false;
    try {
      await handle.chmod(0o644);
      await handle.writeFile(bytes);
      await handle.sync();
      await check();
      try {
        if (claim) await link(temporary, path);
        else await rename(temporary, path);
      } catch (error) {
        // Another same-prefix run can remove a live temporary name. Replay only
        // our own publication and ownership check, without a lease or PID probe.
        if (!missing(error)) throw error;
        retry = true;
      }
    } finally {
      await handle.close();
      await unlink(temporary).catch((error: unknown) => {
        if (!missing(error)) throw error;
      });
    }
    if (!retry) return;
  }
};
const systemctl = async (args: string[]) => {
  // A second terminal group signal can kill Bun's manager child during rollback.
  // Retry only signal deaths, once. These manager operations are idempotent.
  for (let attempt = 0; ; attempt++) {
    try {
      const child = Bun.spawn(["systemctl", "--user", ...args], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env: process.env,
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      if (
        process.env.NEUVE_ROLLBACK_AGENT_RECEIPT &&
        child.signalCode !== null &&
        attempt === 0
      )
        continue;
      return { code, stdout, stderr };
    } catch (error) {
      return { code: 127, stdout: "", stderr: String(error) };
    }
  }
};
const requireSystemctl = async (args: string[]) => {
  const result = await systemctl(args);
  if (result.code !== 0)
    throw new Error(
      `systemctl --user ${args.join(" ")} failed (${result.code}): ${stripWhitespace(result.stderr)}`,
    );
};
export const userSystemdAvailable = async () => {
  try {
    const runtime = process.env.XDG_RUNTIME_DIR;
    if (
      !runtime ||
      !isAbsolute(runtime) ||
      !(await info(join(runtime, "bus")))?.isSocket()
    )
      return false;
    return (await systemctl(["show-environment"])).code === 0;
  } catch {
    return false;
  }
};
const hasDropIns = async (directory: string) => {
  try {
    const folders = [
      directory,
      "/etc/systemd/user",
      "/run/systemd/user",
      "/usr/local/lib/systemd/user",
      "/usr/lib/systemd/user",
    ];
    // XDG base directories count only as nonempty absolute paths.
    const runtime = process.env.XDG_RUNTIME_DIR;
    if (runtime && isAbsolute(runtime))
      folders.push(join(runtime, "systemd/user"));
    for (const folder of folders)
      for (const unit of [SERVICE, TIMER])
        if (await info(join(folder, `${unit}.d`))) return true;
    // Generic drop-ins are common distribution defaults. Only an override of this
    // command or timer target makes ownership undecidable.
    for (const folder of folders)
      for (const kind of ["service", "timer"]) {
        const directory = join(folder, `${kind}.d`);
        const status = await info(directory);
        if (!status) continue;
        if (!status.isDirectory() || status.isSymbolicLink()) return true;
        for (const name of await readdir(directory)) {
          if (!name.endsWith(".conf")) continue;
          const path = join(directory, name);
          const status = await info(path);
          if (!status?.isFile() || status.isSymbolicLink()) return true;
          const bytes = await unitBytes(path);
          const entries = bytes && unitEntries(bytes.toString());
          if (
            !entries ||
            entries.some(
              (entry) =>
                (entry.section === "[Service]" &&
                  (entry.key === "ExecStart" || entry.key === "KillMode")) ||
                (entry.section === "[Timer]" && entry.key === "Unit"),
            )
          )
            return true;
        }
      }
    return false;
  } catch {
    return true;
  }
};
// systemctl 249 prints ExecStart's path and joined argv verbatim, including spaces.
// The fixed metadata suffix and whole-value match reject extra commands and arguments.
const ownsLoadedExec = (value: string | undefined, command: string) => {
  const prefix = `{ path=${command} ; argv[]=${command} worker sweep ; ignore_errors=no ; `;
  return (
    value?.startsWith(prefix) === true &&
    /^start_time=\[[^\]\n]*\] ; stop_time=\[[^\]\n]*\] ; pid=\d+ ; code=(?:[A-Za-z0-9_-]+|\(null\)) ; status=[A-Za-z0-9_/-]+ }$/.test(
      value.slice(prefix.length),
    )
  );
};
const showUnit = async (unit: string, properties: string[]) => {
  const result = await systemctl(["show", "-p", properties.join(","), unit]);
  if (result.code !== 0 || /[\r\0]/.test(result.stdout)) return null;
  const values = new Map<string, string>();
  for (const line of result.stdout.replace(/\n$/, "").split("\n")) {
    const index = line.indexOf("=");
    const key = line.slice(0, index);
    if (index < 1 || values.has(key)) return null;
    values.set(key, line.slice(index + 1));
  }
  return properties.every((key) => values.has(key)) ? values : null;
};
// systemd 249 bus-print-properties.c uses shell_maybe_quote(s, 0) for arrays.
// Scalars such as FragmentPath are printed raw; they must not be shell-unquoted.
const showArray = (value: string | undefined): string[] | null => {
  if (value === undefined || /[\r\0\n]/.test(value)) return null;
  if (value === "") return [];
  const entries: string[] = [];
  const escapes: Record<string, string> = {
    a: "\x07",
    b: "\b",
    f: "\f",
    n: "\n",
    r: "\r",
    t: "\t",
    v: "\v",
    '"': '"',
    "\\": "\\",
    "`": "`",
    $: "$",
  };
  let index = 0;
  while (index < value.length) {
    let entry = "";
    if (value[index] === '"') {
      index++;
      while (index < value.length && value[index] !== '"') {
        const character = value[index++];
        if (character !== "\\") {
          entry += character;
          continue;
        }
        const escaped = value[index++];
        if (escaped === undefined) return null;
        if (Object.hasOwn(escapes, escaped)) entry += escapes[escaped];
        else {
          const octal = value.slice(index - 1, index + 2);
          if (!/^[0-7]{3}$/.test(octal)) return null;
          const byte = Number.parseInt(octal, 8);
          if (byte === 0 || (byte >= 32 && byte !== 127)) return null;
          entry += String.fromCharCode(byte);
          index += 2;
        }
      }
      if (value[index++] !== '"') return null;
    } else {
      const start = index;
      while (index < value.length && value[index] !== " ") {
        if (/[\x00-\x20\x7f"\\`$*?\['()<>|&;!]/.test(value[index] ?? ""))
          return null;
        index++;
      }
      entry = value.slice(start, index);
    }
    if (!entry) return null;
    entries.push(entry);
    if (index === value.length) break;
    if (
      value[index++] !== " " ||
      index === value.length ||
      value[index] === " "
    )
      return null;
  }
  return entries;
};
const ownsLoadedDropIns = async (value: string | undefined) => {
  const paths = showArray(value);
  if (!paths) return false;
  for (const path of paths) {
    if (!isAbsolute(path) || !path.endsWith(".conf")) return false;
    const bytes = await unitBytes(path);
    const entries = bytes && unitEntries(bytes.toString());
    if (
      !entries ||
      entries.some(
        (entry) =>
          (entry.section === "[Service]" &&
            (entry.key === "ExecStart" || entry.key === "KillMode")) ||
          (entry.section === "[Timer]" && entry.key === "Unit"),
      )
    )
      return false;
  }
  return true;
};
const loadedOwnership = async (
  paths: ReturnType<typeof agentUnitPaths>,
  command: string,
  allowUnloaded = false,
): Promise<"current" | "reload" | "foreign"> => {
  try {
    const service = await showUnit(SERVICE, [
      "FragmentPath",
      "DropInPaths",
      "ExecStart",
      "KillMode",
      "NeedDaemonReload",
    ]);
    const timer = await showUnit(TIMER, [
      "FragmentPath",
      "DropInPaths",
      "Triggers",
      "NeedDaemonReload",
    ]);
    if (!service || !timer) return "foreign";
    const fragmentMatches = async (
      fragment: string | undefined,
      path: string,
    ) =>
      fragment !== undefined &&
      isAbsolute(fragment) &&
      join(
        await realpath(dirname(fragment)),
        fragment.slice(fragment.lastIndexOf("/") + 1),
      ) ===
        join(
          await realpath(dirname(path)),
          path.slice(path.lastIndexOf("/") + 1),
        );
    const unloadedService =
      allowUnloaded &&
      service.get("FragmentPath") === "" &&
      service.get("ExecStart") === "";
    const unloadedTimer =
      allowUnloaded &&
      timer.get("FragmentPath") === "" &&
      timer.get("Triggers") === "";
    if (
      (!unloadedService &&
        (!(await fragmentMatches(service.get("FragmentPath"), paths.service)) ||
          !ownsLoadedExec(service.get("ExecStart"), command) ||
          service.get("KillMode") !== "process")) ||
      (!unloadedTimer &&
        (!(await fragmentMatches(timer.get("FragmentPath"), paths.timer)) ||
          JSON.stringify(showArray(timer.get("Triggers"))) !==
            JSON.stringify([SERVICE]))) ||
      !(await ownsLoadedDropIns(service.get("DropInPaths"))) ||
      !(await ownsLoadedDropIns(timer.get("DropInPaths")))
    )
      return "foreign";
    const reload = [
      service.get("NeedDaemonReload"),
      timer.get("NeedDaemonReload"),
    ];
    if (reload.some((value) => value !== "yes" && value !== "no"))
      return "foreign";
    return unloadedService || unloadedTimer || reload.includes("yes")
      ? "reload"
      : "current";
  } catch {
    return "foreign";
  }
};
const claimText = (command: string) =>
  `Neuve installer claim\n${resolve(dirname(command), "..")}\n`;
const preflight = async (paths: ReturnType<typeof agentUnitPaths>) => {
  try {
    return (
      rawPath(paths.directory) &&
      (await safeFile(paths.service)) &&
      (await safeFile(paths.timer))
    );
  } catch {
    return false;
  }
};
type AgentOptions = {
  readonly command: string;
  readonly load: boolean;
  readonly home?: string;
  readonly config?: string;
  readonly receipt?: string;
};

type UnitState = { service: string | null; timer: string | null };
const readState = async (paths: ReturnType<typeof agentUnitPaths>) => ({
  service: encoded(await unitBytes(paths.service)),
  timer: encoded(await unitBytes(paths.timer)),
});
const identity = async (paths: ReturnType<typeof agentUnitPaths>) => {
  const result = [];
  for (const path of [paths.service, paths.timer]) {
    const status = await info(path);
    result.push(status ? `${status.dev}:${status.ino}:${status.nlink}` : null);
  }
  return JSON.stringify(result);
};
const sameState = (a: UnitState, b: UnitState) =>
  a.service === b.service && a.timer === b.timer;
const checkState = async (
  options: AgentOptions,
  expected: UnitState,
  loaded: boolean,
  refusal = FOREIGN,
) => {
  const paths = agentUnitPaths(options.home, options.config);
  const files = async () => {
    if (
      !(await preflight(paths)) ||
      (await hasDropIns(paths.directory)) ||
      !sameState(await readState(paths), expected)
    )
      throw new Error(refusal);
  };
  await files();
  const before = await identity(paths);
  if (
    loaded &&
    (await loadedOwnership(paths, options.command, true)) === "foreign"
  )
    throw new Error(refusal);
  // Manager calls can complete an entire handoff before returning their old answer.
  await files();
  if (before !== (await identity(paths))) throw new Error(refusal);
};
const foreignMessage = async (options: AgentOptions) => {
  const paths = agentUnitPaths(options.home, options.config);
  const bytes = await unitBytes(paths.service);
  const text = bytes?.toString();
  const claimOwner =
    text && /^Neuve installer claim\n(\/[^\r\n\0]+)\n$/.exec(text)?.[1];
  const owner =
    text &&
    (agentOwnerPrefix(text) ??
      (claimOwner && rawPath(claimOwner) ? claimOwner : null));
  if (!owner || resolve(owner, "bin/neuve") === options.command) return FOREIGN;
  const timer = await unitBytes(paths.timer);
  if (
    (timer &&
      !ownsTimer(timer.toString()) &&
      timer.toString() !== claimText(resolve(owner, "bin/neuve"))) ||
    (await hasDropIns(paths.directory))
  )
    return FOREIGN;
  return otherOwnerMessage(owner);
};
// Finish in the caller's direction. An owned service proves the prefix even when
// its timer disappeared; a timer alone cannot identify its owner.
const finishAgent = async (
  options: AgentOptions,
  direction: "install" | "remove",
) => {
  const paths = agentUnitPaths(options.home, options.config);
  if (!(await preflight(paths))) return UNSAFE;
  const state = await readState(paths);
  if (!state.service) return null;
  if (await hasDropIns(paths.directory)) return foreignMessage(options);
  const service = Buffer.from(state.service, "base64").toString();
  if (!ownsService(service, options.command)) return foreignMessage(options);
  if (!state.timer) {
    await checkState(options, state, options.load);
    if (direction === "install") {
      try {
        const { receipt: _receipt, ...repairOptions } = options;
        await installRegistration(repairOptions);
      } catch (error) {
        const remaining = await readState(paths);
        if (
          remaining.service &&
          !remaining.timer &&
          ownsService(
            Buffer.from(remaining.service, "base64").toString(),
            options.command,
          )
        )
          await uninstallRegistration(options);
        throw error;
      }
    } else {
      await uninstallRegistration(options);
    }
    return null;
  }
  if (!ownsTimer(Buffer.from(state.timer, "base64").toString()))
    return foreignMessage(options);
  if (!options.load || !(await userSystemdAvailable())) return null;
  const ownership = await loadedOwnership(paths, options.command, true);
  const enabled = (await systemctl(["is-enabled", TIMER])).code === 0;
  const active = (await systemctl(["is-active", TIMER])).code === 0;
  await checkState(options, state, false);
  if (ownership === "foreign") return foreignMessage(options);
  if (ownership === "reload") {
    await requireSystemctl(["daemon-reload"]);
    await checkState(options, state, true);
  }
  if (!enabled || !active) {
    await checkState(options, state, true);
    await requireSystemctl(["enable", "--now", TIMER]);
    await checkState(options, state, true);
  }
  return null;
};
const endWithAgent = async (
  options: AgentOptions,
  work: () => Promise<string>,
  direction: "install" | "remove" = "remove",
) => {
  let result: string | undefined;
  let failure: unknown;
  try {
    result = await work();
  } catch (error) {
    failure = error;
  }
  let final: string | null = null;
  try {
    final = await finishAgent(options, direction);
  } catch (error) {
    // A recheck can itself observe another completed handoff. Name its owner.
    final = await foreignMessage(options).catch(() => null);
    if (!final || final === FOREIGN) failure ??= error;
  }
  if (final) {
    if (failure)
      throw new Error(
        `${failure instanceof Error ? failure.message : String(failure)} ${final}`,
      );
    return final;
  }
  if (failure) throw failure;
  return result ?? FOREIGN;
};

const rollbackSchema = z.object({
  command: z.string(),
  service: z.string().nullable(),
  timer: z.string().nullable(),
  previousService: z.string().nullable(),
  previousTimer: z.string().nullable(),
  enabled: z.boolean(),
  active: z.boolean(),
});
type Rollback = z.infer<typeof rollbackSchema>;
export const ROLLBACK_REFUSED =
  "Left the systemd timer dev.neuve.worker in place instead of undoing it. Its unit files or loaded settings changed since this install registered it, or the files are no longer safe to change.";
const encoded = (bytes: Buffer | null) => bytes?.toString("base64") ?? null;
const rollbackRegistration = async (options: AgentOptions, state: Rollback) => {
  const paths = agentUnitPaths(options.home, options.config);
  if (
    (state.previousService !== null &&
      !ownsService(
        Buffer.from(state.previousService, "base64").toString(),
        options.command,
      )) ||
    (state.previousTimer !== null &&
      !ownsTimer(Buffer.from(state.previousTimer, "base64").toString()))
  )
    throw new Error(ROLLBACK_REFUSED);
  // Track our own completed changes, so every following step can detect a handoff.
  let service = state.service;
  let timer = state.timer;
  const check = async () => {
    if (state.command !== options.command) throw new Error(ROLLBACK_REFUSED);
    for (const [bytes, owns] of [
      [
        service,
        (text: string) =>
          text === claimText(options.command) ||
          ownsService(text, options.command),
      ],
      [
        timer,
        (text: string) =>
          text === claimText(options.command) || ownsTimer(text),
      ],
    ] as const) {
      if (bytes && !owns(Buffer.from(bytes, "base64").toString()))
        throw new Error(ROLLBACK_REFUSED);
    }
    await checkState(
      options,
      { service, timer },
      options.load,
      ROLLBACK_REFUSED,
    );
  };
  const step = async (work: () => Promise<unknown>) => {
    await check();
    await work();
  };
  if (options.load) {
    if (!state.active) await step(() => requireSystemctl(["stop", TIMER]));
    if (!state.enabled) await step(() => requireSystemctl(["disable", TIMER]));
  }
  if (service !== state.previousService) {
    await step(() =>
      state.previousService === null
        ? unlink(paths.service)
        : putUnit(
            paths.service,
            Buffer.from(state.previousService, "base64"),
            options.command,
            false,
            check,
          ),
    );
    service = state.previousService;
  }
  if (timer !== state.previousTimer) {
    await step(() =>
      state.previousTimer === null
        ? unlink(paths.timer)
        : putUnit(
            paths.timer,
            Buffer.from(state.previousTimer, "base64"),
            options.command,
            false,
            check,
          ),
    );
    timer = state.previousTimer;
  }
  if (options.load) await step(() => requireSystemctl(["daemon-reload"]));
};
export const rollbackAgent = async (
  options: AgentOptions & { receipt: string },
): Promise<string> => {
  if (
    process.env.NEUVE_ROLLBACK_AGENT_ISOLATE === "1" &&
    process.env.NEUVE_ROLLBACK_AGENT_RECEIPT === options.receipt &&
    process.env.NEUVE_ROLLBACK_AGENT_SESSION !== options.receipt
  ) {
    // The installer masks group signals during cleanup. Give its rollback worker
    // a separate group, then restore direct cancellation in that worker below.
    const child = spawn(
      options.command,
      ["worker", "uninstall-agent", ...(options.load ? [] : ["--no-load"])],
      {
        detached: true,
        env: { ...process.env, NEUVE_ROLLBACK_AGENT_SESSION: options.receipt },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (bytes) => {
      stdout += bytes;
    });
    child.stderr.on("data", (bytes) => {
      stderr += bytes;
    });
    const closed = new Promise<void>((resolve) =>
      child.once("close", () => resolve()),
    );
    let code: number | null;
    try {
      code = await new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", resolve);
      });
    } finally {
      // A stopped worker may leave a manager command holding its output pipes.
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch (error) {
          if (!(
            error instanceof Error &&
            "code" in error &&
            error.code === "ESRCH"
          ))
            throw error;
        }
      }
      await closed;
    }
    if (code !== 0)
      throw new Error(
        stderr ||
          (code === null
            ? "Undoing the background worker dev.neuve.worker was stopped by a signal, so neuve and its files were kept."
            : `Undoing the background worker dev.neuve.worker failed with exit status ${code}, so neuve and its files were kept.`),
      );
    return stripWhitespace(stdout);
  }
  const cancel = () => {
    process.exit(143);
  };
  const isolated = process.env.NEUVE_ROLLBACK_AGENT_SESSION === options.receipt;
  if (isolated) process.on("SIGTERM", cancel);
  try {
    return await endWithAgent(options, async () => {
      const bytes = await unitBytes(options.receipt);
      const state = rollbackSchema.parse(
        JSON.parse(bytes?.toString() ?? "null"),
      );
      await rollbackRegistration(options, state);
      return "Restored the systemd timer dev.neuve.worker to how it was before this install.";
    });
  } finally {
    if (isolated) process.removeListener("SIGTERM", cancel);
  }
};

const installRegistration = async (options: AgentOptions): Promise<string> => {
  const paths = agentUnitPaths(options.home, options.config);
  if (options.load && !(await userSystemdAvailable())) return NO_USER_SYSTEMD;
  if (unsupportedExecutable(options.command)) return UNSUPPORTED_EXECUTABLE;
  const service = agentService(options.command);
  try {
    if (
      !rawPath(paths.directory) ||
      !(await safeParents(paths.service)) ||
      !(await safeParents(paths.timer))
    )
      return UNSAFE;
    // KILL between linking a complete claim and unlinking its temporary name
    // leaves two links. Remove this prefix's temporary names before nlink preflight.
    await removeLeftovers(paths.directory, options.command);
  } catch {
    return UNSAFE;
  }
  if (!(await preflight(paths))) return UNSAFE;
  if (await hasDropIns(paths.directory)) return FOREIGN;
  let original = await unitBytes(paths.service);
  let timerOriginal = await unitBytes(paths.timer);
  const claim = claimText(options.command);
  const claimed = original?.toString() === claim;
  const timerClaimed = timerOriginal?.toString() === claim;
  if (timerOriginal && !timerClaimed && !ownsTimer(timerOriginal.toString()))
    return FOREIGN;
  if (
    original &&
    !claimed &&
    !ownsService(original.toString(), options.command)
  )
    return FOREIGN;
  if (
    (!original || claimed) &&
    timerOriginal &&
    !timerClaimed &&
    timerOriginal.toString() !== agentTimer()
  )
    return FOREIGN;
  await mkdir(paths.directory, { recursive: true });
  if (original && !claimed && timerOriginal && !timerClaimed) {
    if (!options.load) return "The systemd timer already runs this install.";
    const ownership = await loadedOwnership(paths, options.command);
    if (ownership === "foreign") return FOREIGN;
    if (
      ownership === "current" &&
      (await systemctl(["is-enabled", TIMER])).code === 0 &&
      (await systemctl(["is-active", TIMER])).code === 0
    )
      return "The systemd timer already runs this install.";
  }
  if (!original) {
    try {
      await putUnit(paths.service, claim, options.command, true);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "EEXIST")
        return FOREIGN;
      throw error;
    }
  }
  if (claimed) original = null;
  if (timerClaimed) timerOriginal = null;
  const state: Rollback = {
    command: options.command,
    service: encoded(original) ?? Buffer.from(claim).toString("base64"),
    timer:
      encoded(timerOriginal) ??
      (timerClaimed ? Buffer.from(claim).toString("base64") : null),
    previousService: encoded(original),
    previousTimer: encoded(timerOriginal),
    enabled:
      options.load && (await systemctl(["is-enabled", TIMER])).code === 0,
    active: options.load && (await systemctl(["is-active", TIMER])).code === 0,
  };
  try {
    // Keep customized owned units intact. Publish only missing files or recovered claims.
    if (!original) {
      await putUnit(paths.service, service, options.command, false, () =>
        checkState(options, state, false),
      );
      state.service = Buffer.from(service).toString("base64");
    }
    if (!timerOriginal) {
      if (!timerClaimed) {
        await putUnit(paths.timer, claim, options.command, true, () =>
          checkState(options, state, false),
        );
        state.timer = Buffer.from(claim).toString("base64");
      }
      await putUnit(paths.timer, agentTimer(), options.command, false, () =>
        checkState(options, state, false),
      );
      state.timer = Buffer.from(agentTimer()).toString("base64");
    }
    if (options.load) {
      await checkState(options, state, false);
      await requireSystemctl(["daemon-reload"]);
      await checkState(options, state, true);
      await requireSystemctl(["enable", "--now", TIMER]);
      await checkState(options, state, true);
    }
    if (options.receipt)
      await writeFile(options.receipt, JSON.stringify(state) + "\n", {
        flag: "wx",
        mode: 0o600,
      });
  } catch (error) {
    try {
      await rollbackRegistration(options, state);
    } catch (failure) {
      throw new AggregateError(
        [error, failure],
        "Couldn't fully restore the systemd timer as it was before this install. " +
          (failure instanceof Error ? failure.message : String(failure)),
      );
    }
    if (error instanceof Error && error.message === FOREIGN) return FOREIGN;
    throw error;
  }
  return options.load
    ? INSTALLED
    : `Wrote ${paths.service} and ${paths.timer} (not loaded: --no-load).`;
};

const uninstallRegistration = async (
  options: AgentOptions,
): Promise<string> => {
  const paths = agentUnitPaths(options.home, options.config);
  if (!(await preflight(paths))) return UNSAFE;
  if (await hasDropIns(paths.directory)) return FOREIGN;
  const service = await unitBytes(paths.service);
  if (!service) {
    if (await unitBytes(paths.timer)) return FOREIGN;
    return `There's no ${paths.service}, so there was nothing to remove.`;
  }
  const claim = service.toString() === claimText(options.command);
  if (!claim && !ownsService(service.toString(), options.command))
    return FOREIGN;
  const timer = await unitBytes(paths.timer);
  if (timer && !ownsTimer(timer.toString())) return FOREIGN;
  if (claim && timer && timer.toString() !== agentTimer()) return FOREIGN;
  if (options.load && !(await userSystemdAvailable()))
    throw new Error(
      "There's no user systemd here, so the systemd timer can't be disabled. Run neuve worker uninstall-agent --no-load to remove its unit files. If you're uninstalling neuve, then run the installer with --uninstall again.",
    );
  if (options.load) {
    const ownership = await loadedOwnership(paths, options.command, !timer);
    if (ownership === "foreign" || (timer && ownership !== "current"))
      return FOREIGN;
    await checkState(
      options,
      { service: encoded(service), timer: encoded(timer) },
      true,
    );
    await requireSystemctl(["disable", "--now", TIMER]);
  }
  const state = { service: encoded(service), timer: encoded(timer) };
  await checkState(options, state, options.load);
  await unlink(paths.service);
  state.service = null;
  if (timer) {
    await checkState(options, state, options.load);
    await unlink(paths.timer);
    state.timer = null;
  }
  if (options.load) {
    await checkState(options, state, true);
    await requireSystemctl(["daemon-reload"]);
    await checkState(options, state, true);
  }
  return "Removed the systemd timer for this install.";
};

export const installAgent = (options: AgentOptions): Promise<string> =>
  endWithAgent(
    options,
    async () => {
      const result = await installRegistration(options);
      return result === FOREIGN ? foreignMessage(options) : result;
    },
    "install",
  );
export const uninstallAgent = (options: AgentOptions): Promise<string> =>
  endWithAgent(options, async () => {
    const result = await uninstallRegistration(options);
    return result === FOREIGN ? foreignMessage(options) : result;
  });
