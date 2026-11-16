import { type OutlineSource } from "../graph-outline.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Gap, Pin } from "./capability.ts";
import {
  listTree,
  readStoreBlobs,
  resolveGitBinary,
  type StoreGit,
} from "./git-store.ts";
import { isIndexed } from "./index-store.ts";
import { detectPins, repositoryGit } from "./pins.ts";
import { readRepoStack } from "./repo-state.ts";
import type { ResolvedStackSettings } from "./settings.ts";
import {
  activeHolds,
  heldBytes,
  readCatalog,
  readHolds,
  storeLayout,
  storeUsage,
} from "./store.ts";
import { scrubbedEnvironment } from "./transport.ts";

/**
 * Reads of the stack store, for `neuve stack list` now and the harness's `stack_list`,
 * `stack_search` and `stack_read` later (ST2). Every read goes through git objects in the store's
 * tree repositories, or lists the read-only folders; nothing is fetched or indexed here.
 */

/** Store git for reads in this process: the same configuration and scrubbed environment. */
export const readGit = (gitPath = resolveGitBinary() ?? "git"): StoreGit => ({
  gitPath,
  env: scrubbedEnvironment({ gitPath, home: tmpdir() }),
});

export interface StackEntryState {
  readonly pin: Pin;
  /** `ready` once its package contents are in the store. */
  readonly status: "ready" | "gap" | "pending";
  readonly gap?: Gap;
  readonly sourceLevel?: "package contents";
  readonly contents?: {
    readonly folder: string;
    readonly tree: string;
    readonly commit: string;
    readonly files: number;
    /** `HEAD` files left out because they would make a folder a git repository. */
    readonly omitted: number;
    readonly indexed: boolean;
  };
  readonly upstream?: {
    readonly key: string;
    readonly level: "attested" | "registry-stated";
    readonly url: string;
    readonly commit: string;
    readonly folder: string;
    readonly tree: string;
    /** The package's own folder in the tree, when the registry names one. */
    readonly directory?: string;
    readonly omitted: number;
    readonly indexed: boolean;
  };
  readonly upstreamGap?: Gap;
  readonly rank?: number;
}

export interface StackState {
  readonly commit: string;
  readonly enabled: boolean;
  readonly setUp: boolean;
  readonly entries: ReadonlyArray<StackEntryState>;
  /** Detection gaps: lockfiles nothing reads, private registries, non-registry sources. */
  readonly gaps: ReadonlyArray<Gap>;
  readonly store: {
    readonly root: string;
    readonly usage: ReturnType<typeof storeUsage>;
    readonly cap: number;
    readonly heldBytes: number;
    /** Open cycles hold more than the cap, so new fetches are refused. */
    readonly heldFull: boolean;
  };
}

/** The stack state a repository pins at `commit`, joined with what the store holds. */
export const stackStateAt = async (options: {
  readonly repository: string;
  readonly source: OutlineSource;
  readonly storeDirectory: string;
  readonly storeRoot: string;
  readonly commit: string;
  readonly settings: ResolvedStackSettings;
  readonly now?: number;
}): Promise<StackState> => {
  const source = options.source;
  const root = options.storeRoot;
  const repo = await readRepoStack(options.storeDirectory);
  const detected = await detectPins(
    repositoryGit(options.repository),
    options.commit,
    {
      privateDefaultRegistry: options.settings.privateDefaultRegistry,
    },
  );
  const catalog = await readCatalog(root);
  const holds = activeHolds(await readHolds(root), options.now ?? Date.now());
  const held = heldBytes(catalog, holds);
  const entries: Array<StackEntryState> = [];
  for (const pin of detected.pins) {
    const record = catalog.packages[pin.key];
    const outcome = repo?.outcomes[pin.key];
    const link = repo?.upstream[pin.key];
    const upstream =
      record?.upstream === undefined
        ? undefined
        : catalog.upstream[record.upstream];
    const ready = record !== undefined && record.integrity === pin.integrity;
    const contents = ready
      ? {
          folder: join(root, record.folder),
          tree: record.tree,
          commit: record.commit,
          files: record.files,
          omitted: record.omitted ?? 0,
          indexed: await isIndexed(root, record.tree, source),
        }
      : undefined;
    entries.push({
      pin,
      status: ready ? "ready" : outcome?.state === "gap" ? "gap" : "pending",
      ...(ready ? { sourceLevel: "package contents" as const } : {}),
      ...(!ready && outcome?.gap !== undefined ? { gap: outcome.gap } : {}),
      ...(contents === undefined ? {} : { contents }),
      ...(upstream === undefined || !ready
        ? {}
        : {
            upstream: {
              key: upstream.key,
              level: upstream.level,
              url: upstream.url,
              commit: upstream.commit,
              folder: join(root, upstream.folder),
              tree: upstream.tree,
              ...(link?.directory === undefined
                ? {}
                : { directory: link.directory }),
              omitted: upstream.omitted,
              indexed: await isIndexed(root, upstream.tree, source),
            },
          }),
      ...(link?.gap === undefined || upstream !== undefined
        ? {}
        : { upstreamGap: link.gap }),
      ...(link === undefined ? {} : { rank: link.rank }),
    });
  }
  const usage = storeUsage(catalog);
  return {
    commit: options.commit,
    enabled: (repo?.enabled ?? false) && options.settings.enabled,
    setUp: repo !== undefined,
    entries,
    gaps: detected.gaps,
    store: {
      root,
      usage,
      cap: options.settings.totalBytes,
      heldBytes: held,
      heldFull: held > options.settings.totalBytes,
    },
  };
};

/** Files of one entry tree under a prefix, from its tree repository. */
export const listEntryFiles = async (
  git: StoreGit,
  root: string,
  tree: string,
  prefix = "",
) =>
  (await listTree(git, storeLayout(root).treeRepository(tree), tree)).filter(
    (entry) => entry.type === "blob" && entry.path.startsWith(prefix),
  );

/** One file of an entry tree, or null when it is absent or the filter left it out. */
export const readEntryFile = async (
  git: StoreGit,
  root: string,
  tree: string,
  path: string,
): Promise<Uint8Array | null> => {
  const gitDir = storeLayout(root).treeRepository(tree);
  const entry = (await listTree(git, gitDir, tree)).find(
    (item) => item.path === path,
  );
  if (entry === undefined || entry.type !== "blob") return null;
  for await (const { bytes } of readStoreBlobs(git, gitDir, [entry.oid]))
    return bytes;
  return null;
};
