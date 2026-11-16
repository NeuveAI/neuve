import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { Effect } from "effect";
import { resolveStoreLocation } from "@neuve/records-core";
import { claimWorkerLock } from "../../../packages/records-core/src/worker-socket.ts";

/**
 * Where the Graph engine's temporary view of a revision (a Git worktree graph-client adds and
 * removes) goes for `neuve query --refresh-cache`. The engine refuses a view whose Git metadata
 * leaves the repository's volume, so the view must be on that volume; and it must sit outside the
 * Git directory, where the engine would also check every committed link the view holds (a link to
 * `/dev/null` or to another disk then refuses the repository). The first that works, of:
 *
 * 1. `<temporary folder>/neuve-<uid>/graph-views/`, when the temporary folder is on the
 *    repository's volume (the usual case);
 * 2. `/private/tmp/neuve-<uid>/graph-views/`, when that is;
 * 3. `<top of the repository's volume>/.neuve-<uid>/graph-views/`, only when neither is;
 * 4. the repository's store, `<git common dir>/neuve/graph/views/`, where the engine still refuses
 *    committed links that leave the volume; `neuve query` then says so plainly.
 *
 * Every folder of ours on that path is made with a plain `mkdir` and accepted only when `lstat`
 * shows a real folder owned by this user with no group or other access, so a folder someone else
 * made, a looser one or a link at either level makes Neuve use the next place, and nothing is
 * followed through a link. Each use holds its own `run-*` folder with the worker's kind of lifetime
 * lock (a SQLite write lock the kernel drops when the process ends) and records the repository its
 * view belongs to. When a use ends it removes its folder and then each of our levels that is empty.
 * A folder whose lock is free belongs to a use that ended without that (a killed process): the next
 * use removes it after unregistering its view in the repository it belongs to.
 */
const OWNED = (uid: number, top: boolean) => `${top ? "." : ""}neuve-${uid}`;
const VIEWS = "graph-views";

const device = async (path: string) =>
  stat(path).then(
    (info) => info.dev,
    () => undefined,
  );

const inside = (path: string, folder: string) =>
  path === folder || path.startsWith(`${folder}${sep}`);

/** The top of the volume `path` is on: the last folder up from it on the same device. */
const volumeRoot = async (path: string) => {
  const own = await device(path);
  let at = path;
  while (dirname(at) !== at && (await device(dirname(at))) === own)
    at = dirname(at);
  return at;
};

const git = async (repository: string, args: string[]) => {
  const child = Bun.spawn(["git", "-C", repository, ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  });
  const [stdout, code] = await Promise.all([
    new Response(child.stdout).text(),
    child.exited,
  ]);
  return { stdout, code };
};

/**
 * The folder we are making something in went away: another use removed it once empty. macOS
 * reports ENOENT, or EINVAL when the removal is still under way as `mkdtemp` runs.
 */
const vanished = (error: unknown) =>
  error instanceof Error &&
  "code" in error &&
  (error.code === "ENOENT" || error.code === "EINVAL");

/** A real folder of this user's with no group or other access; never a link. */
const ours = (info: Awaited<ReturnType<typeof lstat>>) => {
  const uid = process.getuid?.();
  return (
    !info.isSymbolicLink() &&
    info.isDirectory() &&
    (uid === undefined || info.uid === uid) &&
    (Number(info.mode) & 0o077) === 0
  );
};
const ownFolder = async (path: string) => {
  const info = await lstat(path).catch(() => undefined);
  return info !== undefined && ours(info);
};

/**
 * `/private/tmp`, the second place. A test process may name another folder for it, so a test can
 * refuse it as it refuses the temporary folder's level, whatever disk `/private/tmp` is on.
 */
const sharedTemporary = () =>
  (process.env.NEUVE_TEST_PROCESS === "1"
    ? process.env.NEUVE_TEST_SHARED_TMP
    : undefined) ?? "/private/tmp";

/** Another use removed a level between our steps: the whole step starts again. */
class LevelGone extends Error {}

/**
 * Makes `path` if absent, with a plain `mkdir`, and accepts it only when it is our own folder.
 * A level that vanished meanwhile (another use's release removed it once empty) is `LevelGone`.
 */
const ownLevel = async (path: string) => {
  await mkdir(path, { mode: 0o700 }).catch((error: unknown) => {
    if (vanished(error)) throw new LevelGone(path);
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST"))
      throw error;
  });
  const info = await lstat(path).catch(() => undefined);
  if (info === undefined) throw new LevelGone(path);
  if (!ours(info))
    throw new Error(`${path} isn't a private folder of this user's`);
};

/**
 * Makes and checks each level, outermost first, then the use's own `run-*` folder in the
 * innermost, as one step. Once the run folder exists no level is empty, so no release removes it.
 * A release can only win before that, and then the step runs again from the outermost level: a
 * bounded few times, since each loss needs another use's release to land in that same gap.
 */
const ATTEMPTS = 8;
const runFolderIn = async (levels: ReadonlyArray<string>) => {
  for (let attempt = 1; ; attempt++) {
    try {
      for (const level of levels) await ownLevel(level);
      return await mkdtemp(join(levels[levels.length - 1]!, "run-")).catch(
        (error: unknown) => {
          throw vanished(error) ? new LevelGone(String(error)) : error;
        },
      );
    } catch (error) {
      if (!(error instanceof LevelGone) || attempt === ATTEMPTS) throw error;
    }
  }
};

export type ViewRun = Readonly<{
  /** The use's own `run-*` folder. */
  folder: string;
  /** Where `run-*` folders go. */
  base: string;
  /** Our levels from the innermost out, each removed when the last use leaves it empty. */
  levels: ReadonlyArray<string>;
  /** Inside the store: the engine still refuses committed links that leave the volume. */
  store: boolean;
}>;

/** Graph's view would have to go inside the store, and the store's folder for it isn't ours. */
export const STORE_VIEWS_REFUSED = (path: string) =>
  `Neuve found no folder of its own for Graph's temporary view: ${path} is a link, isn't yours, or others can open it. Remove it, then run this again.`;

/**
 * The folder views go in for this repository, the first place that meets every check, with this
 * use's run folder already made inside it.
 */
const viewRun = async (repository: string): Promise<ViewRun | undefined> => {
  const repo = await realpath(repository);
  const own = await device(repo);
  const location = await Effect.runPromise(
    Effect.result(resolveStoreLocation(repo)),
  );
  const common =
    location._tag === "Success" ? dirname(location.success.directory) : repo;
  const uid = process.getuid?.() ?? 0;
  const socketRoot = await realpath("/tmp").catch(() => "/private/tmp");
  const parents: Array<{ parent: string; top: boolean }> = [];
  for (const folder of [tmpdir(), sharedTemporary()]) {
    const real = await realpath(folder).catch(() => undefined);
    if (real !== undefined && (await device(real)) === own)
      parents.push({ parent: real, top: false });
  }
  // The volume's top only when no temporary folder is on the repository's volume.
  if (parents.length === 0)
    parents.push({ parent: await volumeRoot(repo), top: true });
  for (const { parent, top } of parents) {
    const owned = join(parent, OWNED(uid, top));
    const base = join(owned, VIEWS);
    if (inside(owned, repo) || inside(owned, common)) continue;
    if ((await device(parent)) !== own) continue;
    // `/private/tmp/neuve-<uid>` is also the worker's socket folder (records-core's
    // `privateSocketDirectory`): only our own level inside it is ever removed.
    const shared = owned === join(socketRoot, `neuve-${uid}`);
    try {
      const folder = await runFolderIn([owned, base]);
      return {
        folder,
        base,
        levels: shared ? [base] : [base, owned],
        store: false,
      };
    } catch {
      // Not ours, not private, a link, or not writable: the next place.
    }
  }
  if (location._tag !== "Success") return undefined;
  // The store's `graph` folder is shared with the harness's work there: it must be a real folder
  // of this user's, never a link; `views` inside it is ours and checked like every other level.
  const graph = join(location.success.directory, "graph");
  const store = join(graph, "views");
  await mkdir(graph, { recursive: true, mode: 0o700 });
  const info = await lstat(graph);
  if (
    info.isSymbolicLink() ||
    !info.isDirectory() ||
    info.uid !== (process.getuid?.() ?? info.uid)
  )
    throw new Error(STORE_VIEWS_REFUSED(graph));
  const folder = await runFolderIn([store]).catch((error: unknown) => {
    throw error instanceof LevelGone
      ? error
      : new Error(STORE_VIEWS_REFUSED(store));
  });
  return { folder, base: store, levels: [store], store: true };
};

/** The worktrees `repository` has registered, by path. */
const worktreesOf = async (repository: string) =>
  (await git(repository, ["worktree", "list", "--porcelain"])).stdout
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length));

/**
 * Removes the folders of ended uses under `base`: a real `run-*` folder with its lock file and its
 * owner record, whose lock is free. Its view is unregistered first, in the repository it belongs
 * to, then the folder goes. A folder still held, or one missing either file, is left alone.
 */
const pruneEnded = async (base: string) => {
  for (const name of await readdir(base).catch(() => [] as string[])) {
    if (!name.startsWith("run-")) continue;
    const folder = join(base, name);
    if (!(await ownFolder(folder))) continue;
    const lockFile = await lstat(join(folder, "run.sqlite")).catch(
      () => undefined,
    );
    if (lockFile === undefined || !lockFile.isFile()) continue;
    const owner = await readFile(join(folder, "owner"), "utf8").catch(
      () => undefined,
    );
    if (owner === undefined || !owner.startsWith("/")) continue;
    const lock = Effect.runSync(
      Effect.result(claimWorkerLock(join(folder, "run.sqlite"))),
    );
    if (lock._tag === "Failure" || lock.success === undefined) continue;
    try {
      // A repository that is gone has nothing left to unregister.
      if ((await lstat(owner).catch(() => undefined)) !== undefined) {
        for (const worktree of await worktreesOf(owner))
          if (inside(worktree, folder))
            await git(owner, ["worktree", "remove", "--force", worktree]);
        await git(owner, ["worktree", "prune"]);
      }
      await rm(folder, { recursive: true, force: true });
    } finally {
      lock.success.close();
    }
  }
};

/** Removes each of our levels that is empty, innermost first; stops at the first that isn't. */
const removeEmptyLevels = async (levels: ReadonlyArray<string>) => {
  for (const level of levels)
    if (
      !(await rmdir(level).then(
        () => true,
        () => false,
      ))
    )
      return;
};

/**
 * A folder for one use's view, held until `release`: graph-client's `temporaryParent`. Ended
 * uses' leftovers are removed first. Undefined outside Git.
 */
export const viewFolder = async (repository: string) => {
  const chosen = await viewRun(repository);
  if (chosen === undefined) return undefined;
  const repo = await realpath(repository);
  const { folder } = chosen;
  // The owner record first, then the lock under a name the pruner ignores, renamed into place
  // only once held, so no pruner ever sees a lock file that isn't held yet.
  await writeFile(join(folder, "owner"), repo, { mode: 0o600 });
  const lock = Effect.runSync(claimWorkerLock(join(folder, "taking.sqlite")));
  if (lock === undefined) throw new Error(`${folder} is held by another use`);
  await rename(join(folder, "taking.sqlite"), join(folder, "run.sqlite"));
  // Our own folder keeps the levels in place while ended uses' are removed.
  await pruneEnded(chosen.base);
  return {
    parent: folder,
    store: chosen.store,
    release: async () => {
      lock.close();
      await rm(folder, { recursive: true, force: true });
      await git(repo, ["worktree", "prune"]);
      await removeEmptyLevels(chosen.levels);
    },
  };
};
