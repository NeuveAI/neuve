import { hostname } from "node:os";
import { basename } from "node:path";

/** One row of a process-table snapshot. `start` fingerprints the process so a reused PID never matches. */
export interface ProcessRow {
  readonly pid: number;
  readonly ppid: number;
  readonly start: string;
  readonly command: string;
}

/** A process recorded as a session's owner: PID, start fingerprint and host, since PIDs are local. */
export interface ProcessIdentity {
  readonly pid: number;
  readonly start: string;
  readonly host: string;
}

export type Snapshot = ReadonlyMap<number, ProcessRow>;

// `lstart` is five fields, such as `Sat Oct 17 13:30:35 2026`; `comm` may contain spaces.
const ROW =
  /^\s*(?<pid>\d+)\s+(?<ppid>\d+)\s+(?<start>\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(?<command>.+)$/;

/** Parses `ps -A -o pid=,ppid=,lstart=,comm=` output. */
export const parseProcessTable = (text: string): Snapshot => {
  const rows = new Map<number, ProcessRow>();
  for (const line of text.split("\n")) {
    const groups = ROW.exec(line)?.groups;
    if (groups === undefined) continue;
    const pid = Number(groups["pid"]);
    rows.set(pid, {
      pid,
      ppid: Number(groups["ppid"]),
      start: groups["start"]!.replace(/\s+/g, " "),
      command: groups["command"]!.trim(),
    });
  }
  return rows;
};

/**
 * One snapshot of the process table from a single `ps` call (D23). Bun exposes only the parent PID,
 * so walking further needs the table. Agent sandboxes may forbid listing processes; that returns
 * `undefined`, and callers fall back to the `--session` override or record no link.
 */
export const snapshotProcesses = (): Snapshot | undefined => {
  try {
    const result = Bun.spawnSync(
      ["ps", "-A", "-o", "pid=,ppid=,lstart=,comm="],
      {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "ignore",
        env: { ...process.env, LC_ALL: "C" },
      },
    );
    if (!result.success) return undefined;
    const table = parseProcessTable(result.stdout.toString());
    return table.has(process.pid) ? table : undefined;
  } catch {
    return undefined;
  }
};

const MAX_DEPTH = 32;

/** The process and its ancestors, nearest first, as far as the snapshot reaches. */
export const lineage = (snapshot: Snapshot, pid: number) => {
  const chain: Array<ProcessRow> = [];
  const seen = new Set<number>();
  let row = snapshot.get(pid);
  while (row !== undefined && !seen.has(row.pid) && chain.length < MAX_DEPTH) {
    chain.push(row);
    seen.add(row.pid);
    if (row.ppid <= 1) break;
    row = snapshot.get(row.ppid);
  }
  return chain;
};

/**
 * Processes that never own an agent session: shells and `env` that run hook commands, and git, which
 * runs git hooks. Interpreters such as node or bun are not listed, because for some harnesses the
 * runtime is the agent itself (the same rule entire-cli's process walk follows).
 */
const TRANSIENT = new Set([
  "sh",
  "bash",
  "zsh",
  "dash",
  "fish",
  "ash",
  "ksh",
  "env",
  "git",
]);

export const identityOf = (row: ProcessRow): ProcessIdentity => ({
  pid: row.pid,
  start: row.start,
  host: hostname(),
});

/**
 * The agent process that ran this hook: the nearest ancestor of `pid` that is not a shell, `env` or
 * git. `pid` itself is the hook process and is skipped.
 */
export const hookOwner = (
  snapshot: Snapshot,
  pid: number = process.pid,
): ProcessIdentity | undefined => {
  const owner = lineage(snapshot, pid)
    .slice(1)
    .find((row) => !TRANSIENT.has(basename(row.command).toLowerCase()));
  return owner === undefined ? undefined : identityOf(owner);
};

export const sameProcess = (a: ProcessIdentity, b: ProcessIdentity) =>
  a.pid === b.pid && a.start === b.start && a.host === b.host;
