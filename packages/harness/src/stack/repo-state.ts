import { preserveUnknown, safeRead } from "@neuve/records-schema";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { Gap, Pin } from "./capability.ts";
import { STACK_LIMITS } from "./settings.ts";

/**
 * A repository's stack pins, in `.git/neuve/stack.json` beside its Records store (decision 11.15,
 * proposal SC2): which entries each revision pins, what became of each entry's fetch, its upstream
 * link and rank, and the head-only budget's rolling ledger. The store itself is user-level and
 * shared; this file is the repository's own and lives and dies with the clone (8.6).
 */

const Iso = z.string().min(1);

export const Outcome = z.strictObject({
  state: z.enum(["ready", "gap"]),
  at: Iso,
  gap: Gap.optional(),
});
export type Outcome = z.infer<typeof Outcome>;

export const RepoStack = z.strictObject({
  version: z.literal(1),
  enabled: z.boolean(),
  /** How it was turned off: `setup hooks --no-stack` or `setup stack --off`. */
  disabledBy: z.enum(["--no-stack", "--off"]).optional(),
  updatedAt: Iso,
  /** The entries pinned per commit, newest first, for the last `MAX_REVISIONS` commits looked at. */
  revisions: z.array(
    z.strictObject({
      commit: z.string().min(1),
      checkedAt: Iso,
      pins: z.array(z.string()),
      gaps: z.array(Gap),
    }),
  ),
  /** Every entry seen at those commits. */
  entries: z.record(z.string(), Pin),
  /** When this repository last pinned each entry, for the store's 30-day eviction. */
  seen: z.record(z.string(), Iso),
  outcomes: z.record(z.string(), Outcome),
  /** Upstream trees: the store key each entry links to, its rank, or why it has none. */
  upstream: z.record(
    z.string(),
    z.strictObject({
      rank: z.int().min(0),
      at: Iso,
      tree: z.string().optional(),
      /** The package's own folder in the upstream tree, when the registry names one. */
      directory: z.string().optional(),
      gap: Gap.optional(),
    }),
  ),
  /** Unvetted entries fetched in the rolling window (SC7's head-only budget). */
  budget: z.array(
    z.strictObject({ key: z.string(), bytes: z.int().min(0), at: Iso }),
  ),
});
export type RepoStack = z.infer<typeof RepoStack>;

export const MAX_REVISIONS = 20;

export const repoStackPath = (storeDirectory: string) =>
  join(storeDirectory, "stack.json");

export const emptyRepoStack = (
  enabled: boolean,
  now = new Date(),
): RepoStack => ({
  version: 1,
  enabled,
  updatedAt: now.toISOString(),
  revisions: [],
  entries: {},
  seen: {},
  outcomes: {},
  upstream: {},
  budget: [],
});

/** The repository's stack state, or undefined when `setup stack` never ran here. */
export const readRepoStack = async (
  storeDirectory: string,
): Promise<RepoStack | undefined> => {
  let text: string;
  try {
    text = await readFile(repoStackPath(storeDirectory), "utf8");
  } catch {
    return undefined;
  }
  const parsed = safeRead(RepoStack, JSON.parse(text), {
    source: repoStackPath(storeDirectory),
  });
  if (!parsed.success)
    throw new Error(
      `${repoStackPath(storeDirectory)} does not parse: ${parsed.error.message.slice(0, 300)}`,
    );
  return parsed.data;
};

/** Production writers hold the shared stack store lock through preservation and publication. */
export const writeRepoStack = async (
  storeDirectory: string,
  state: RepoStack,
) => {
  const path = repoStackPath(storeDirectory);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const stored = await readFile(path, "utf8").catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return undefined;
    },
  );
  const next =
    stored === undefined
      ? RepoStack.parse(state)
      : preserveUnknown(RepoStack, JSON.parse(stored), state, {
          source: repoStackPath(storeDirectory),
          arrayKeys: { revisions: ["commit"], budget: ["key", "at"] },
        });
  await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, {
    mode: 0o600,
  });
  await rename(temporary, path);
};

/** What remains of the head-only budget now: entries and bytes in the rolling window. */
export const budgetLeft = (state: RepoStack, now: number) => {
  const window = state.budget.filter(
    (charge) => now - Date.parse(charge.at) < STACK_LIMITS.unvettedWindowMs,
  );
  return {
    entries: STACK_LIMITS.unvettedEntries - window.length,
    bytes:
      STACK_LIMITS.unvettedBytes -
      window.reduce((sum, charge) => sum + charge.bytes, 0),
    window,
  };
};

/** Records the pins of one commit, newest first, keeping the last `MAX_REVISIONS`. */
export const recordRevision = (
  state: RepoStack,
  commit: string,
  pins: ReadonlyArray<Pin>,
  gaps: ReadonlyArray<Gap>,
  now: Date,
) => {
  const at = now.toISOString();
  state.revisions = [
    {
      commit,
      checkedAt: at,
      pins: pins.map((pin) => pin.key),
      gaps: [...gaps],
    },
    ...state.revisions.filter((revision) => revision.commit !== commit),
  ].slice(0, MAX_REVISIONS);
  for (const pin of pins) {
    state.entries[pin.key] = pin;
    state.seen[pin.key] = at;
  }
  // What no kept revision pins any more leaves the file; `seen` keeps what eviction still reads.
  const kept = new Set(state.revisions.flatMap((revision) => revision.pins));
  for (const key of Object.keys(state.entries))
    if (!kept.has(key)) {
      delete state.entries[key];
      delete state.outcomes[key];
      delete state.upstream[key];
    }
  for (const [key, seenAt] of Object.entries(state.seen))
    if (now.getTime() - Date.parse(seenAt) > 2 * STACK_LIMITS.staleMs)
      delete state.seen[key];
};
