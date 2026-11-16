import { z } from "zod";

/**
 * Stack sources' bounds (decision 11.15, proposal SC3, SC6 and SC7). The total is the user's to
 * change in their settings; the per-entry limits, the upstream share and the head-only budget are
 * fixed as ruled. Everything is in bytes or milliseconds.
 */
export const STACK_LIMITS = {
  /** The store in total: extracted files, git objects and indexes (11.15: 5 GiB). */
  totalBytes: 5 * 1024 ** 3,
  /** One package's contents, unpacked. */
  packageBytes: 256 * 1024 ** 2,
  /** One upstream tree, after the 1 MiB blob filter, counted in its quarantine. */
  upstreamTreeBytes: 128 * 1024 ** 2,
  /** Every upstream tree in the store, files and objects together. */
  upstreamBytes: 1024 ** 3,
  /** Distinct upstream trees one repository's ranking may pick. */
  upstreamTrees: 10,
  /** The blob filter of an upstream fetch. */
  upstreamBlobLimit: "1m",
  /** Files in one archive or tree before it is refused. */
  maxEntries: 100_000,
  /** The head-only budget: entries the default branch's head does not pin, per rolling day. */
  unvettedEntries: 10,
  unvettedBytes: 256 * 1024 ** 2,
  unvettedWindowMs: 24 * 60 * 60 * 1000,
  /** A git fetch, then SIGTERM to its process group, then SIGKILL after the grace. */
  fetchTimeoutMs: 5 * 60 * 1000,
  killGraceMs: 5_000,
  /** One registry download, retries included. */
  downloadTimeoutMs: 2 * 60 * 1000,
  /** Registry metadata and attestation documents, and the time for each, retries included. */
  metadataBytes: 8 * 1024 ** 2,
  metadataTimeoutMs: 30 * 1000,
  /** An entry no registered repository pinned for this long is evicted first. */
  staleMs: 30 * 24 * 60 * 60 * 1000,
  /** A cycle with no run for this long stops holding its entries (10.79's stand-in). */
  holdMs: 7 * 24 * 60 * 60 * 1000,
  /** The ranking grep's output before it is cut off. */
  rankOutputBytes: 16 * 1024 ** 2,
  /** Distinct query terms one search reads postings for. */
  queryTerms: 32,
} as const;

/** The git hosts upstream trees may come from when the user's settings name none. */
export const DEFAULT_GIT_HOSTS: ReadonlyArray<string> = [
  "github.com",
  "gitlab.com",
];

const Host = z
  .string()
  .regex(
    /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/,
    "Expected a lowercase host name",
  );

/** The `stack` section of the user's settings (`settings.ts`). Every field is optional. */
export const StackSettings = z.strictObject({
  /** False turns stack sources off for every repository of this user. */
  enabled: z.boolean().optional(),
  /** The store's total cap in bytes; 5 GiB when absent. */
  totalBytes: z
    .int()
    .min(64 * 1024 ** 2)
    .optional(),
  /** Hosts upstream trees may be fetched from; github.com and gitlab.com when absent. */
  gitHosts: z.array(Host).max(32).optional(),
  /**
   * The user's package manager resolves the default registry to a private one (a mirror set
   * outside the repository). Every entry is then a disclosed gap, never looked up publicly (SC4).
   */
  privateDefaultRegistry: z.boolean().optional(),
  /**
   * The harness's stack tools (`stack_list`, `stack_search`, `stack_read`; 11.15, ST2). Off unless
   * true: with it off a review has exactly the tools, prompts and computation keys it had before
   * ST2, and no stack state is frozen. Turning it on is its own measured step against the end-to-end
   * check's baseline (10.99). Fetching (`enabled`) is independent of it.
   */
  tools: z.boolean().optional(),
});
export type StackSettings = z.infer<typeof StackSettings>;

/**
 * What a review request freezes about the stack tools (config.ts): present only when the user's
 * settings turn them on, so a run with them off keeps its key. The index recipe and Graph source
 * identity are in it because `stack_search`'s answers depend on both.
 */
export const StackToolsConfig = z.strictObject({
  tools: z.literal(true),
  /** The store index recipe and Graph source identity (`frozen-state.ts`). */
  index: z.string().min(1),
});
export type StackToolsConfig = z.infer<typeof StackToolsConfig>;

/** What a fetch runs with: the settings resolved against the defaults. */
export const ResolvedStackSettings = z.strictObject({
  enabled: z.boolean(),
  totalBytes: z.int().min(1),
  gitHosts: z.array(Host),
  privateDefaultRegistry: z.boolean(),
});
export type ResolvedStackSettings = z.infer<typeof ResolvedStackSettings>;

export const resolveStackSettings = (
  settings: StackSettings | undefined,
): ResolvedStackSettings => ({
  enabled: settings?.enabled ?? true,
  totalBytes: settings?.totalBytes ?? STACK_LIMITS.totalBytes,
  gitHosts: [...(settings?.gitHosts ?? DEFAULT_GIT_HOSTS)],
  privateDefaultRegistry: settings?.privateDefaultRegistry ?? false,
});
