import { processAlive, withFileLock } from "@neuve/records-core/file-lock";
import { knownStackIndex } from "./index-meta.ts";
import { preserveUnknown, safeRead } from "@neuve/records-schema";
import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { STACK_LIMITS } from "./settings.ts";

/**
 * The user-level stack store (decision 11.15, proposal SC2 and SC6): one store shared by every
 * repository of the user, outside any repository and outside Records. It is a rebuildable cache of
 * third-party inputs, the third kind of persistence ([record 0012](../../../../architecture/decisions/0012-stack-store.md)).
 *
 * - `trees/<tree OID>.git/`: one bare repository per tree, written once, never repacked,
 *   garbage-collected or checked with `fsck`; evicted by deleting its directory.
 * - `src/<ecosystem>/<name>@<version>/` and `upstream/<host>/<path>@<commit>/`: read-only extracted
 *   files of package contents and upstream trees, for inner-loop agents and plain tools.
 * - `index/<tree OID>/`: each tree's persisted search index.
 * - `quarantine/`: fetches in progress, deleted on every ending.
 * - `catalog.json`: what the store holds; `holds.json`: what open review cycles hold.
 *
 * The path is built from the home directory only, as the settings path is.
 */
export const stackStorePath = (home = homedir()) =>
  process.platform === "darwin"
    ? join(home, "Library", "Caches", "Neuve", "stack")
    : join(home, ".cache", "neuve", "stack");

const Iso = z.string().min(1);

export const PackageRecord = z.strictObject({
  key: z.string().min(1),
  ecosystem: z.string().min(1),
  name: z.string().min(1),
  version: z.string().min(1),
  integrity: z.string().min(1),
  tree: z.string().min(1),
  /** The commit object the store made for the tree. */
  commit: z.string().min(1),
  /** The read-only folder, relative to the store root. */
  folder: z.string().min(1),
  files: z.int().min(0),
  fileBytes: z.int().min(0),
  objectBytes: z.int().min(0),
  fetchedAt: Iso,
  lastUsedAt: Iso,
  /** The upstream tree's key when one was fetched for it. */
  upstream: z.string().optional(),
  /** Files left out: `HEAD` files that would make a folder a bare repository. */
  omitted: z.int().min(0).optional(),
});
export type PackageRecord = z.infer<typeof PackageRecord>;

export const UpstreamRecord = z.strictObject({
  /** `<host>/<path>@<commit>`. */
  key: z.string().min(1),
  host: z.string().min(1),
  path: z.string().min(1),
  commit: z.string().min(1),
  url: z.string().min(1),
  level: z.enum(["attested", "registry-stated"]),
  tree: z.string().min(1),
  folder: z.string().min(1),
  files: z.int().min(0),
  /**
   * Blobs the 1 MiB filter left out, links and submodules, which are never written, and `HEAD` files
   * that would make a folder a bare repository.
   */
  omitted: z.int().min(0),
  fileBytes: z.int().min(0),
  objectBytes: z.int().min(0),
  fetchedAt: Iso,
  lastUsedAt: Iso,
});
export type UpstreamRecord = z.infer<typeof UpstreamRecord>;

export const IndexRecord = z.strictObject({
  tree: z.string().min(1),
  recipe: z.string().min(1),
  bytes: z.int().min(0),
  docs: z.int().min(0),
  builtAt: Iso,
});
export type IndexRecord = z.infer<typeof IndexRecord>;

export const Catalog = z.strictObject({
  version: z.literal(1),
  packages: z.record(z.string(), PackageRecord),
  upstream: z.record(z.string(), UpstreamRecord),
  indexes: z.record(z.string(), IndexRecord),
  /** What eviction removed, so a refetch that fails can say "no longer available". */
  evicted: z.record(
    z.string(),
    z.strictObject({ at: Iso, reason: z.string() }),
  ),
});
export type Catalog = z.infer<typeof Catalog>;

export const Hold = z.strictObject({
  /** The repository's Records store directory (`.git/neuve`). */
  store: z.string().min(1),
  cycleId: z.string().min(1),
  packages: z.array(z.string()),
  upstream: z.array(z.string()),
  /** The cycle's last run; past `STACK_LIMITS.holdMs` the hold is released (10.79). */
  lastRunAt: Iso,
});
export type Hold = z.infer<typeof Hold>;

const Holds = z.strictObject({
  version: z.literal(1),
  holds: z.array(Hold),
});

const emptyCatalog = (): Catalog => ({
  version: 1,
  packages: {},
  upstream: {},
  indexes: {},
  evicted: {},
});

export const storeLayout = (root: string) => ({
  root,
  catalog: join(root, "catalog.json"),
  holds: join(root, "holds.json"),
  lock: join(root, "lock"),
  trees: join(root, "trees"),
  quarantine: join(root, "quarantine"),
  index: join(root, "index"),
  treeRepository: (tree: string) => join(root, "trees", `${tree}.git`),
  indexFolder: (tree: string) => join(root, "index", tree),
  packageFolder: (ecosystem: string, name: string, version: string) =>
    join("src", ecosystem, `${name}@${version}`),
  upstreamFolder: (host: string, path: string, commit: string) =>
    join("upstream", host, `${path}@${commit}`),
});

const readJson = async <T>(
  path: string,
  schema: z.ZodType<T>,
  empty: () => T,
) => {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return empty();
  }
  const parsed = safeRead(schema, JSON.parse(text), { source: path });
  if (!parsed.success)
    throw new Error(
      `${path} does not parse: ${parsed.error.message.slice(0, 300)}`,
    );
  return parsed.data;
};

const writeJson = async <T>(path: string, schema: z.ZodType<T>, value: T) => {
  const stored = await readFile(path, "utf8").catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return undefined;
    },
  );
  const next =
    stored === undefined
      ? schema.parse(value)
      : preserveUnknown(schema, JSON.parse(stored), value, {
          source: path,
          arrayKeys: { holds: ["store", "cycleId"] },
        });
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`);
  await rename(temporary, path);
};

export const readCatalog = (root: string) =>
  readJson(storeLayout(root).catalog, Catalog, emptyCatalog);

export const writeCatalog = (root: string, catalog: Catalog) =>
  writeJson(storeLayout(root).catalog, Catalog, catalog);

export const readHolds = async (root: string) =>
  (
    await readJson(storeLayout(root).holds, Holds, () => ({
      version: 1 as const,
      holds: [],
    }))
  ).holds;

const contents = async (path: string) => {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
};

export { FileLocked as StoreLocked } from "@neuve/records-core/file-lock";

/** Catalog, holds, pins, eviction and index publication share the same lock path. */
export const withStoreLock = <A>(
  root: string,
  work: () => Promise<A>,
  waitMs = 120_000,
  signal?: AbortSignal,
): Promise<A> => withFileLock(storeLayout(root).lock, work, waitMs, signal);

/**
 * A `.git` file at the store root that points nowhere, so git's repository discovery from inside the
 * store stops there with an error instead of walking on into the user's home (defence in depth beside
 * `bareRepositoryHeads`; the skill also says to run no git there).
 */
export const writeStoreGuard = async (root: string) => {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const guard = join(root, ".git");
  const text = "gitdir: /nonexistent/neuve-stack-store-is-not-a-repository\n";
  if ((await contents(guard)) !== text)
    await writeFile(guard, text, { mode: 0o444 }).catch(async () => {
      await rm(guard, { force: true, recursive: true });
      await writeFile(guard, text, { mode: 0o444 });
    });
};

/** Holds an open review cycle takes on entries; ST2's frozen stack state calls this. */
export const recordHold = (root: string, hold: Hold) =>
  withStoreLock(root, async () => {
    const holds = (await readHolds(root)).filter(
      (entry) =>
        !(entry.store === hold.store && entry.cycleId === hold.cycleId),
    );
    await writeJson(storeLayout(root).holds, Holds, {
      version: 1,
      holds: [...holds, hold],
    });
  });

/** Ends a cycle's hold, when the cycle closes. */
export const releaseHold = (root: string, store: string, cycleId: string) =>
  withStoreLock(root, async () => {
    const holds = (await readHolds(root)).filter(
      (entry) => !(entry.store === store && entry.cycleId === cycleId),
    );
    await writeJson(storeLayout(root).holds, Holds, { version: 1, holds });
  });

/** The holds still in force: a cycle with no run for 7 days stops holding (10.79). */
export const activeHolds = (holds: ReadonlyArray<Hold>, now: number) =>
  holds.filter(
    (hold) => now - Date.parse(hold.lastRunAt) <= STACK_LIMITS.holdMs,
  );

/** Deletes a folder the store wrote read-only, making its folders writable first. */
export const removeReadOnly = async (path: string): Promise<void> => {
  const walk = async (dir: string) => {
    try {
      await chmod(dir, 0o700);
    } catch {
      return;
    }
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries)
      if (entry.isDirectory()) await walk(join(dir, entry.name));
  };
  try {
    if (!(await stat(path)).isDirectory()) {
      await rm(path, { force: true });
      return;
    }
  } catch {
    return;
  }
  await walk(path);
  await rm(path, { recursive: true, force: true });
};

/** Writes files under `folder` (which must not exist), then makes the files and folders read-only. */
export const writeReadOnlyFolder = async (
  folder: string,
  files:
    | Iterable<{ readonly path: string; readonly bytes: Uint8Array }>
    | AsyncIterable<{ readonly path: string; readonly bytes: Uint8Array }>,
) => {
  const folders = new Set<string>([folder]);
  let count = 0;
  let bytes = 0;
  const written: Array<string> = [];
  await mkdir(folder, { recursive: true });
  for await (const file of files) {
    const target = join(folder, file.path);
    const parent = dirname(target);
    if (!folders.has(parent)) {
      await mkdir(parent, { recursive: true });
      for (let dir = parent; dir.length > folder.length; dir = dirname(dir))
        folders.add(dir);
    }
    // `wx`: an existing path (a collision the checks missed) fails instead of being overwritten.
    await writeFile(target, file.bytes, { flag: "wx", mode: 0o444 });
    written.push(file.path);
    count++;
    bytes += file.bytes.byteLength;
  }
  return { files: count, bytes, paths: written, folders };
};

/**
 * Makes every folder under `path`, and `path` itself, read-only, deepest first. Done once the folder
 * is in place: moving a read-only folder to another parent is refused on macOS.
 */
export const sealTree = async (path: string): Promise<void> => {
  let entries;
  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries)
    if (entry.isDirectory()) await sealTree(join(path, entry.name));
  await chmod(path, 0o555);
};

/** A fresh quarantine directory, named for this process so a dead fetch's leftovers can be found. */
export const quarantineDirectory = async (root: string) => {
  const { quarantine } = storeLayout(root);
  await mkdir(quarantine, { recursive: true, mode: 0o700 });
  return join(quarantine, `${process.pid}-${randomUUID()}`);
};

/** Removes quarantines whose fetching process is gone. */
export const clearDeadQuarantines = async (root: string) => {
  const { quarantine } = storeLayout(root);
  let names: Array<string>;
  try {
    names = await readdir(quarantine);
  } catch {
    return 0;
  }
  let cleared = 0;
  for (const name of names) {
    if (
      !/^[1-9]\d*-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
        name,
      )
    )
      continue;
    const pid = Number(name.split("-")[0]);
    if (Number.isInteger(pid) && pid > 0 && processAlive(pid)) continue;
    await removeReadOnly(join(quarantine, name));
    cleared++;
  }
  return cleared;
};

/** Bytes the store holds by its catalog: extracted files, objects and indexes. */
export const storeUsage = (catalog: Catalog) => {
  let packages = 0;
  let upstream = 0;
  let indexes = 0;
  for (const record of Object.values(catalog.packages))
    packages += record.fileBytes + record.objectBytes;
  for (const record of Object.values(catalog.upstream))
    upstream += record.fileBytes + record.objectBytes;
  for (const record of Object.values(catalog.indexes)) indexes += record.bytes;
  return { packages, upstream, indexes, total: packages + upstream + indexes };
};

export interface EvictionContext {
  readonly now: number;
  readonly cap: number;
  /** The last time any registered repository pinned each package key. */
  readonly pinnedAt: ReadonlyMap<string, number>;
  readonly pinsKnown?: boolean;
  readonly holds: ReadonlyArray<Hold>;
  readonly log?: (line: string) => void;
}

type Unit =
  | {
      readonly kind: "package";
      readonly key: string;
      readonly record: PackageRecord;
    }
  | {
      readonly kind: "upstream";
      readonly key: string;
      readonly record: UpstreamRecord;
    };

const heldSets = (catalog: Catalog, holds: ReadonlyArray<Hold>) => {
  const packages = new Set(holds.flatMap((hold) => hold.packages));
  const upstream = new Set(holds.flatMap((hold) => hold.upstream));
  for (const key of packages) {
    const linked = catalog.packages[key]?.upstream;
    if (linked !== undefined) upstream.add(linked);
  }
  return { packages, upstream };
};

/** Bytes the open cycles' holds keep in the store. */
export const heldBytes = (catalog: Catalog, holds: ReadonlyArray<Hold>) => {
  const held = heldSets(catalog, holds);
  let bytes = 0;
  for (const key of held.packages) {
    const record = catalog.packages[key];
    if (record !== undefined)
      bytes +=
        record.fileBytes +
        record.objectBytes +
        (catalog.indexes[record.tree]?.bytes ?? 0);
  }
  for (const key of held.upstream) {
    const record = catalog.upstream[key];
    if (record !== undefined)
      bytes +=
        record.fileBytes +
        record.objectBytes +
        (catalog.indexes[record.tree]?.bytes ?? 0);
  }
  return bytes;
};

const unitBytes = (catalog: Catalog, unit: Unit) =>
  unit.record.fileBytes +
  unit.record.objectBytes +
  (catalog.indexes[unit.record.tree]?.bytes ?? 0);

/** Deletes one unit's folder, tree repository and index, unless another record shares the tree. */
const removeUnit = async (
  root: string,
  catalog: Catalog,
  unit: Unit,
  reason: string,
) => {
  const layout = storeLayout(root);
  const tree = unit.record.tree;
  if (unit.kind === "package") delete catalog.packages[unit.key];
  else {
    delete catalog.upstream[unit.key];
    for (const record of Object.values(catalog.packages))
      if (record.upstream === unit.key) delete record.upstream;
  }
  const shared =
    Object.values(catalog.packages).some((record) => record.tree === tree) ||
    Object.values(catalog.upstream).some((record) => record.tree === tree);
  await removeReadOnly(join(root, unit.record.folder));
  if (!shared) {
    await removeReadOnly(layout.treeRepository(tree));
    await removeReadOnly(layout.indexFolder(tree));
    delete catalog.indexes[tree];
  }
  catalog.evicted[unit.key] = { at: new Date().toISOString(), reason };
};

/**
 * Eviction (SC6): first every unit no registered repository pinned for 30 days, then, while the
 * store plus `need` passes the cap, the least recently used. A unit an open cycle holds is never
 * evicted. Returns whether `need` more bytes now fit, and if not whether the holds are the reason
 * ("stack store full: held by open cycles").
 */
export const evict = async (
  root: string,
  catalog: Catalog,
  need: number,
  context: EvictionContext,
): Promise<{
  readonly fits: boolean;
  readonly heldFull: boolean;
  readonly evicted: ReadonlyArray<string>;
  readonly deferredIndexes: ReadonlyArray<string>;
}> => {
  if (context.pinsKnown === false)
    return {
      fits: storeUsage(catalog).total + need <= context.cap,
      heldFull: false,
      evicted: [],
      deferredIndexes: [],
    };
  // Eviction consumes both documents. A newer hold may protect entries through fields this
  // build cannot see, so discovering it after deleting the files would be too late.
  for (const [path, schema] of [
    [storeLayout(root).catalog, Catalog],
    [storeLayout(root).holds, Holds],
  ] as const) {
    const text = await readFile(path, "utf8").catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
        return undefined;
      },
    );
    if (text === undefined) continue;
    const stored = safeRead<Catalog | z.infer<typeof Holds>>(
      schema,
      JSON.parse(text),
    );
    if (!stored.success)
      throw new Error("stack eviction metadata does not parse");
    // A hold's unknown fields do not extend its known seven-day lifetime. Keep the file,
    // but only unknown fields outside expired holds can defer known eviction work.
    const storedHolds = "holds" in stored.data ? stored.data.holds : undefined;
    const expiredHoldFields =
      path === storeLayout(root).holds &&
      storedHolds !== undefined &&
      stored.droppedPaths.every(
        ([field, index]) =>
          field === "holds" &&
          typeof index === "number" &&
          storedHolds[index] !== undefined &&
          context.now - Date.parse(storedHolds[index].lastRunAt) >
            STACK_LIMITS.holdMs,
      );
    if (stored.droppedKeys.length > 0 && !expiredHoldFields)
      return {
        fits: storeUsage(catalog).total + need <= context.cap,
        heldFull: false,
        evicted: [],
        deferredIndexes: [],
      };
  }
  const holds = activeHolds(context.holds, context.now);
  const held = heldSets(catalog, holds);
  const evicted: Array<string> = [];
  const deferredIndexes = new Set<string>();
  const canRemove = async (unit: Unit) => {
    if (deferredIndexes.has(unit.record.tree)) return false;
    if (await knownStackIndex(storeLayout(root).indexFolder(unit.record.tree)))
      return true;
    deferredIndexes.add(unit.record.tree);
    context.log?.(
      "stack eviction deferred: leaving index metadata and its source to a newer build",
    );
    return false;
  };
  const units = (): Array<Unit> => [
    ...Object.entries(catalog.packages).map(([key, record]): Unit => ({
      kind: "package",
      key,
      record,
    })),
    ...Object.entries(catalog.upstream).map(([key, record]): Unit => ({
      kind: "upstream",
      key,
      record,
    })),
  ];
  const isHeld = (unit: Unit) =>
    unit.kind === "package"
      ? held.packages.has(unit.key)
      : held.upstream.has(unit.key);
  const pinnedAt = (unit: Unit) => {
    if (unit.kind === "package") return context.pinnedAt.get(unit.key) ?? 0;
    let latest = 0;
    for (const record of Object.values(catalog.packages))
      if (record.upstream === unit.key)
        latest = Math.max(latest, context.pinnedAt.get(record.key) ?? 0);
    return latest;
  };
  // Stale: neither pinned by a registered repository nor used by a fetch for 30 days.
  for (const unit of units())
    if (
      !isHeld(unit) &&
      context.now -
        Math.max(pinnedAt(unit), Date.parse(unit.record.lastUsedAt)) >
        STACK_LIMITS.staleMs
    ) {
      if (!(await canRemove(unit))) continue;
      await removeUnit(
        root,
        catalog,
        unit,
        "not pinned by any repository for 30 days",
      );
      evicted.push(unit.key);
    }
  const order = units()
    .filter((unit) => !isHeld(unit))
    .sort(
      (a, b) =>
        Date.parse(a.record.lastUsedAt) - Date.parse(b.record.lastUsedAt) ||
        (a.key < b.key ? -1 : 1),
    );
  for (const unit of order) {
    if (storeUsage(catalog).total + need <= context.cap) break;
    if (unitBytes(catalog, unit) === 0 || !(await canRemove(unit))) continue;
    await removeUnit(
      root,
      catalog,
      unit,
      "least recently used, over the store's cap",
    );
    evicted.push(unit.key);
  }
  const fits = storeUsage(catalog).total + need <= context.cap;
  return {
    fits,
    heldFull: !fits && heldBytes(catalog, holds) + need > context.cap,
    evicted,
    deferredIndexes: [...deferredIndexes],
  };
};
