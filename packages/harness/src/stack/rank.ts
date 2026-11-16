import { setPriority } from "node:os";
import type { EcosystemCapability, Pin } from "./capability.ts";
import { STACK_LIMITS } from "./settings.ts";

/**
 * Ranking by use (proposal SC3): one bounded `git grep -F` over a revision's tree for the quoted
 * reference forms each capability states for its entries, with 2 threads, at nice 10 and with its
 * output capped; it starts behind the heavy-work gate because the whole fetch job does. Each entry's
 * rank is the number of tracked files that reference it. Manifests and lockfiles are left out, since
 * every dependency is named there. No category of "framework" is needed: use is the evidence.
 */

export interface Ranking {
  /** Files referencing each entry key. */
  readonly ranks: ReadonlyMap<string, number>;
  /** The entries any of `paths` references (a review's changed files), from the same grep. */
  readonly referencedBy: (paths: ReadonlyArray<string>) => ReadonlySet<string>;
  /** The output passed its cap; ranks count what was read before it. */
  readonly truncated: boolean;
}

export const rankPins = async (
  repository: string,
  commit: string,
  pins: ReadonlyArray<Pin>,
  capabilities: ReadonlyArray<EcosystemCapability>,
  options: {
    readonly gitPath?: string;
    readonly env?: Readonly<Record<string, string>>;
    readonly outputCap?: number;
    readonly signal?: AbortSignal;
  } = {},
): Promise<Ranking> => {
  const byForm = new Map<string, Set<string>>();
  const excluded = new Set<string>();
  for (const pin of pins) {
    const capability = capabilities.find(
      (entry) => entry.ecosystem === pin.ecosystem,
    );
    if (capability === undefined) continue;
    for (const name of [...capability.manifests, ...capability.lockfiles])
      excluded.add(name);
    for (const form of capability.referenceForms(pin.name)) {
      const keys = byForm.get(form) ?? new Set<string>();
      keys.add(pin.key);
      byForm.set(form, keys);
    }
  }
  const ranks = new Map<string, number>(pins.map((pin) => [pin.key, 0]));
  const filesOf = new Map<string, Array<string>>();
  const referencedBy = (paths: ReadonlyArray<string>) => {
    const wanted = new Set(paths);
    const out = new Set<string>();
    for (const [path, keys] of filesOf)
      if (wanted.has(path)) for (const key of keys) out.add(key);
    return out;
  };
  if (byForm.size === 0) return { ranks, truncated: false, referencedBy };
  const args = [
    "-C",
    repository,
    "grep",
    "-F",
    "-o",
    "-I",
    "-z",
    "--no-color",
    "--threads=2",
    ...[...byForm.keys()].flatMap((form) => ["-e", form]),
    commit,
    "--",
    ...[...excluded].flatMap((name) => [`:(exclude,glob)**/${name}`]),
  ];
  const child = Bun.spawn([options.gitPath ?? "git", ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
    ...(options.env === undefined ? {} : { env: { ...options.env } }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  try {
    setPriority(child.pid, 10);
  } catch {
    // A sandbox may refuse; the grep still runs with its thread bound.
  }
  const cap = options.outputCap ?? STACK_LIMITS.rankOutputBytes;
  const seen = new Set<string>();
  const prefix = `${commit}:`;
  let read = 0;
  let truncated = false;
  let pending = "";
  const decoder = new TextDecoder();
  const take = (line: string) => {
    const nul = line.indexOf("\0");
    if (nul === -1) return;
    const path = line.slice(0, nul).replace(prefix, "");
    const form = line.slice(nul + 1);
    for (const key of byForm.get(form) ?? []) {
      const id = `${key}\0${path}`;
      if (seen.has(id)) continue;
      seen.add(id);
      ranks.set(key, (ranks.get(key) ?? 0) + 1);
      filesOf.set(path, [...(filesOf.get(path) ?? []), key]);
    }
  };
  for await (const chunk of child.stdout) {
    read += chunk.byteLength;
    if (read > cap) {
      truncated = true;
      child.kill("SIGKILL");
      break;
    }
    pending += decoder.decode(chunk, { stream: true });
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) take(line);
  }
  if (!truncated && pending !== "") take(pending);
  await child.exited;
  return { ranks, truncated, referencedBy };
};
