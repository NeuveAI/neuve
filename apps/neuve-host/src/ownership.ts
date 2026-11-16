import { constants, Database } from "bun:sqlite";
import { closeSync, lstatSync, openSync } from "node:fs";
import { join } from "node:path";

const held = new Map<string, Database>();

/** A persistent inode carries the kernel lock; it is never unlinked, including after a crash. */
export function acquireHome(home: string): () => void {
	const path = join(home, "host.lock");
	try {
		closeSync(openSync(path, "wx", 0o600));
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
	}
	const stat = lstatSync(path);
	if (
		!stat.isFile() ||
		stat.nlink !== 1 ||
		stat.uid !== process.getuid!() ||
		(stat.mode & 0o077) !== 0
	) {
		throw new Error("The host lock must be a private regular file owned by you with one link");
	}
	const identity = `${stat.dev}:${stat.ino}`;
	const busy = () =>
		new Error(`${home} is already served by another host (host ownership is held)`);
	if (held.has(identity)) throw busy();
	const db = new Database(path, constants.SQLITE_OPEN_READWRITE | constants.SQLITE_OPEN_NOFOLLOW);
	try {
		// Concurrent first claims can briefly share read locks before either promotes to EXCLUSIVE.
		db.run("PRAGMA busy_timeout=250");
		// WAL's EXCLUSIVE transaction permits other readers; this lock only accepts rollback mode.
		const mode = db.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get();
		if (mode?.journal_mode !== "delete")
			throw new Error("The host lock must use SQLite rollback mode");
		db.run("BEGIN EXCLUSIVE");
		db.query("PRAGMA schema_version").get();
	} catch (error) {
		db.close();
		if (error instanceof Error && "code" in error && error.code === "SQLITE_BUSY") throw busy();
		throw error;
	}
	held.set(identity, db);
	return () => {
		if (held.get(identity) !== db) return;
		db.close();
		held.delete(identity);
	};
}
