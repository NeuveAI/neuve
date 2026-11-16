import { Database } from "bun:sqlite";
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { StoreWithoutLog } from "./errors.ts";

/**
 * The one home for read-only opens of a database that may be in WAL mode. Review keeps new ones here.
 *
 * A WAL file with no `-wal` beside it is what a clean close leaves and also what a lost WAL leaves,
 * and nothing in the file says which. SQLite's read-only open answers differently by library:
 * upstream creates the sidecars beside the file, which writes to something the reader only meant to
 * read, and reads it as whole. Apple's library won't create the WAL and refuses with error 14. Bun
 * loads Apple's library on macOS, and its `node:sqlite` removes the sidecars at close. So these
 * ask first and answer the same on every library: never create a sidecar, and never read such a
 * file without telling the caller.
 */

const SQLITE_CANTOPEN = 14;
const WAL_FORMAT = 2;

/** Whether a file in WAL mode has no WAL beside it. A live WAL connection always has one, so this never opens a live file. */
export const walWithoutLog = (path: string) => {
  if (existsSync(`${path}-wal`)) return false;
  let file: number;
  try {
    file = openSync(path, "r");
  } catch {
    return false;
  }
  const header = Buffer.alloc(20);
  try {
    if (readSync(file, header, 0, 20, 0) < 20) return false;
  } finally {
    closeSync(file);
  }
  return (
    header.toString("latin1", 0, 16) === "SQLite format 3\0" &&
    header[18] === WAL_FORMAT
  );
};

/** SQLite's refusal of a read-only open, as Apple's library gives it for a WAL file with no WAL. */
export const cannotOpen = (error: unknown) =>
  error instanceof Error &&
  (("errcode" in error && error.errcode === SQLITE_CANTOPEN) ||
    ("errno" in error && error.errno === SQLITE_CANTOPEN) ||
    ("code" in error && error.code === "SQLITE_CANTOPEN"));

/**
 * A copy nobody else can reach, read from its bytes alone. SQLite takes no locks here and assumes
 * the file can't change, so anything another process could write to needs `readAsItStands`.
 */
export const openPrivateCopy = (path: string) => {
  const uri = pathToFileURL(path);
  uri.searchParams.set("immutable", "1");
  return new DatabaseSync(uri.href, { readOnly: true });
};

/**
 * For a reader that must see every commit. A WAL file with no WAL is refused rather than trusted,
 * and the first read happens here because SQLite only meets the WAL then.
 */
export const openStoreReader = (
  path: string,
  options: { readonly create?: false; readonly strict?: true } = {},
) => {
  if (walWithoutLog(path)) throw new StoreWithoutLog({ path });
  const database = new Database(path, { readonly: true, ...options });
  try {
    database.query("SELECT 1 FROM sqlite_schema LIMIT 1").get();
    return database;
  } catch (error) {
    database.close();
    // The last connection may close between the check and the read.
    if (cannotOpen(error) && walWithoutLog(path))
      throw new StoreWithoutLog({ path });
    throw error;
  }
};

/**
 * Opens a database for reading, closed or open, without writing beside it. `withoutLog` says the
 * file had no WAL, so nothing shows its last commits are in it, and the connection takes no locks.
 * The caller says so to its reader, and answers for what a writer arriving later does to it:
 * `readAsItStands` checks that for one read, and a reader that stays open has to look again with
 * `watchUnchanged`, or it won't see later commits. Use this only when wrong bytes can't pass.
 */
export const openAsItStands = (path: string) => {
  if (!walWithoutLog(path)) {
    const database = new DatabaseSync(path, { readOnly: true, timeout: 5_000 });
    try {
      database.prepare("SELECT 1 FROM sqlite_schema LIMIT 1").get();
      return { database, withoutLog: false };
    } catch (error) {
      database.close();
      // The last connection may close between the check and the read.
      if (!cannotOpen(error) || !walWithoutLog(path)) throw error;
    }
  }
  return { database: openPrivateCopy(path), withoutLog: true };
};

/**
 * Some file systems, HFS+ among them, keep modification times in whole seconds, so a change within
 * the second the file last changed wouldn't show. Starting after that second means any later change does.
 */
const waitOutLastChange = (path: string) => {
  const wait =
    (Math.floor(statSync(path).mtimeMs / 1_000) + 1) * 1_000 - Date.now();
  if (wait > 0)
    Atomics.wait(
      new Int32Array(new SharedArrayBuffer(4)),
      0,
      0,
      Math.min(wait, 1_000),
    );
};

/**
 * A check that a file with no WAL still is what it was. A writer creates the WAL and its checkpoint
 * changes the file. If the file last changed in this very second, a change now couldn't show, so
 * this answers no until a later look.
 */
export const watchUnchanged = (path: string) => {
  const identity = () => {
    const { ino, size, mtimeMs } = statSync(path);
    return `${ino}:${size}:${mtimeMs}`;
  };
  const seen = identity();
  const settled =
    Math.floor(statSync(path).mtimeMs / 1_000) < Math.floor(Date.now() / 1_000);
  return () => settled && !existsSync(`${path}-wal`) && identity() === seen;
};

export class StoreChangedDuringRead extends Error {
  readonly _tag = "StoreChangedDuringRead";
  constructor(readonly path: string) {
    super(`${path} changed while it was read with no WAL`);
  }
}

/**
 * One read of a database as it stands. With no WAL the read takes no locks, so a writer arriving
 * during it could mix states. A file that didn't change was read whole; anything else is refused.
 */
export const readAsItStands = <A>(
  path: string,
  read: (database: DatabaseSync) => A,
): { readonly value: A; readonly withoutLog: boolean } => {
  const { database, withoutLog } = openAsItStands(path);
  let unchanged = () => true;
  let value: A;
  try {
    if (withoutLog) {
      waitOutLastChange(path);
      unchanged = watchUnchanged(path);
    }
    value = read(database);
  } finally {
    database.close();
    if (!unchanged()) throw new StoreChangedDuringRead(path);
  }
  return { value, withoutLog };
};

/** What a reader says when `withoutLog` is true. */
export const readWithoutLog = (path: string) =>
  `read ${path} as it stands: it has no WAL beside it, so nothing shows its last commits are in it`;
