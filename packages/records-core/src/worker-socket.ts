import { EventEmitter } from "node:events";
import { createConnection } from "node:net";
import { Buffer } from "node:buffer";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  statSync,
  existsSync,
  unlinkSync,
} from "node:fs";
import { Database } from "bun:sqlite";
import { basename, dirname, join } from "node:path";
import * as BunSocket from "@effect/platform-bun/BunSocket";
import * as BunSocketServer from "@effect/platform-bun/BunSocketServer";
import { Data, Duration, Effect, Option, Queue } from "effect";
import { z } from "zod";
import * as Socket from "effect/socket/Socket";
import { sha256Hex } from "./canonical.ts";
import type { StoreLocation } from "./location.ts";
import {
  openStoreReader,
  readAsItStands,
  StoreChangedDuringRead,
} from "./read-only.ts";
import { spawnObserver } from "./store-watch.ts";

/** macOS limits a Unix socket path to 104 bytes including the terminator. */
const SOCKET_PATH_MAX = 103;

// Like the host catalog observer, this process owns exactly one FSEvents stream for its lifetime.
// Watching the directory survives SQLite checkpoints, WAL truncation and WAL deletion/recreation.
const databaseObserver = `const {watch} = require("node:fs");
const {dirname, basename} = require("node:path");
const database = process.argv.at(-1), name = basename(database);
const watcher = watch(dirname(database), (_, file) => {
  if (file === null || file === name || file === name + "-wal") process.send("change");
});
watcher.on("error", error => { console.error(error.message); process.exit(1); });
process.on("disconnect", () => { watcher.close(); process.exit(0); });
process.send("ready");`;

/** Isolated from transient watches in job handlers; a failed observer ends the worker. */
export const watchRecordsDatabase = (database: string, changed: () => void) =>
  spawnObserver({
    script: databaseObserver,
    argument: database,
    cwd: dirname(database),
    label: "Records database watcher",
    messages: ["ready", "change"],
    received: () => changed(),
  });

/**
 * Where a store's worker listens and holds its lifetime lock (8.2).
 *
 * - `socket`: `/tmp/neuve-<uid>/<first 32 hex of sha256(real store path)>.sock`, always outside the
 *   repository. Neuve Graph's metadata walk refuses any socket under the Git common directory except
 *   Git's own fsmonitor, so a socket in the store would fail every engine query while a worker runs.
 *   The name depends on nothing in the environment (not `TMPDIR`, not `HOME`) and on no spelling of
 *   the repository path, so every process of the user finds the same socket.
 * - `legacy`: `<store>/worker.sock`, where builds before this one bound when that path fits a Unix
 *   socket. Discovery still reaches a worker of such a build there; a stale file there is removed.
 * - `lock`: the lifetime lock, at the same file every build has used (the legacy socket path, or the
 *   hashed one when that is too long, plus `.sqlite`), so a worker of any build holds off every other.
 *   It is a regular file, which the engine's walk accepts.
 */
export interface WorkerPaths {
  readonly socket: string;
  readonly legacy: string | undefined;
  readonly lock: string;
}

/** The socket path cannot be prepared, for example when `/tmp/neuve-<uid>` is not private. */
export class WorkerSocketUnavailable extends Data.TaggedError(
  "WorkerSocketUnavailable",
)<{ readonly message: string; readonly cause: unknown }> {}

const unavailable = (cause: unknown) =>
  new WorkerSocketUnavailable({
    message: cause instanceof Error ? cause.message : String(cause),
    cause,
  });

/** Every reader and the worker itself take the paths from here; it checks the directory each time. */
export const workerPathsFor = (location: StoreLocation) =>
  Effect.try({ try: () => workerPathsSync(location), catch: unavailable });

/** The socket the worker binds: `WorkerPaths.socket`. */
export const socketPathFor = (location: StoreLocation) =>
  Effect.map(workerPathsFor(location), (paths) => paths.socket);

/** The same paths without preparing the socket's private directory. Safe for diagnosis. */
export const socketPathReadOnly = (location: StoreLocation) =>
  workerPathsSync(location, false).socket;

const workerPathsSync = (
  location: StoreLocation,
  prepare = true,
): WorkerPaths => {
  let commonDirectory = dirname(location.directory);
  try {
    commonDirectory = realpathSync(commonDirectory);
  } catch {
    // The repository is gone; hash the path as given.
  }
  const real = join(commonDirectory, basename(location.directory));
  const socket = join(
    prepare
      ? privateSocketDirectory()
      : `/tmp/neuve-${process.getuid?.() ?? 0}`,
    `${sha256Hex(real).slice(0, 32)}.sock`,
  );
  const beside = join(location.directory, "worker.sock");
  const fits = Buffer.byteLength(beside) <= SOCKET_PATH_MAX;
  return {
    socket,
    legacy: fits ? beside : undefined,
    lock: `${fits ? beside : socket}.sqlite`,
  };
};

/**
 * `/tmp/neuve-<uid>`, created 0700. An existing entry must be a real directory (checked without
 * following a link) owned by this uid with no group or other access; Neuve never changes the
 * mode or owner of one it did not create.
 */
export const privateSocketDirectory = (root = "/tmp") => {
  const uid = process.getuid?.() ?? 0;
  const directory = join(root, `neuve-${uid}`);
  try {
    mkdirSync(directory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const entry = lstatSync(directory);
  const where = `Neuve keeps the worker's socket in ${directory}, which must be a directory private to you`;
  if (entry.isSymbolicLink())
    throw new Error(
      `${where}, but it is a symbolic link, which Neuve does not follow. Remove the link (rm ${directory}) and run the command again.`,
    );
  if (!entry.isDirectory())
    throw new Error(
      `${where}, but it is not a directory. Remove it (rm ${directory}) and run the command again.`,
    );
  if (entry.uid !== uid)
    throw new Error(
      `${where}, but it belongs to uid ${entry.uid}, not to you (uid ${uid}). Have its owner or an administrator remove it, then run the command again.`,
    );
  if ((entry.mode & 0o077) !== 0)
    throw new Error(
      `${where}, but others can access it (mode ${(entry.mode & 0o777).toString(8)}). Run chmod 700 ${directory} and run the command again.`,
    );
  return directory;
};

/** `drop <seq>` aborts that running job's attempt and ends it dropped (`neuve jobs drop`). */
export type SocketCommand =
  "wake" | "status" | "stop" | `drop ${number}` | `publish ${number}`;

/**
 * What one connection to the worker's socket showed. Only `Absent` (no socket file) and `Answered`
 * are certain. `Unanswered` means the connection was accepted, or was still being set up, with no
 * reply in time: the kernel accepts for a stopped or busy worker too, so it counts as live.
 * `Refused` retains the connect error. ECONNREFUSED can also mean a full live accept queue.
 * Neither an absent path nor a refusal proves that the worker released its lifetime lock.
 */
export type Reach =
  | { readonly _tag: "Answered"; readonly reply: string }
  | { readonly _tag: "Unanswered" }
  | { readonly _tag: "Refused"; readonly code: string }
  | { readonly _tag: "Absent" };

/** A worker answered or accepted the connection. */
export const isLive = (reach: Reach) =>
  reach._tag === "Answered" || reach._tag === "Unanswered";

const connectErrorCode = (error: unknown): string | undefined => {
  if (!Socket.isSocketError(error)) return undefined;
  const reason = error.reason;
  if (reason._tag !== "SocketOpenError" || reason.kind !== "Unknown")
    return undefined;
  const code = (reason.cause as { code?: unknown } | undefined)?.code;
  return typeof code === "string" ? code : "UNKNOWN";
};

/**
 * Opens one connection to the socket, sends `command` (if any) and reads one reply line, all within
 * `timeout`. Without a command it only checks whether the connection is accepted.
 */
export const reachWorker = (
  path: string,
  command?: SocketCommand,
  timeout: Duration.Input = "1 second",
): Effect.Effect<Reach> =>
  Effect.gen(function* () {
    let connected = false;
    const exchange = Effect.gen(function* () {
      const socket = yield* BunSocket.makeNet({ path, openTimeout: timeout });
      const pull = yield* Socket.readerString(socket);
      connected = true;
      if (command === undefined) return Option.none<string>();
      const writer = yield* socket.writer;
      yield* writer.write(`${command}\n`);
      let buffer = "";
      while (true) {
        buffer += (yield* pull).join("");
        const end = buffer.indexOf("\n");
        if (end >= 0) return Option.some(buffer.slice(0, end));
      }
    }).pipe(Effect.scoped, Effect.timeout(timeout));
    const result = yield* Effect.result(exchange);
    if (result._tag === "Success")
      return Option.match(result.success, {
        onNone: (): Reach => ({ _tag: "Unanswered" }),
        onSome: (reply): Reach => ({ _tag: "Answered", reply }),
      });
    const code = connected ? undefined : connectErrorCode(result.failure);
    if (code === undefined) return { _tag: "Unanswered" } as Reach;
    if (code === "ENOENT") return { _tag: "Absent" } as Reach;
    return { _tag: "Refused", code } as Reach;
  });

/** What reaching a store's worker showed, and the socket it showed it on. */
export interface WorkerReach {
  readonly socket: string;
  readonly reach: Reach;
}

/**
 * The one way every reader reaches a store's worker: the socket outside the repository first, then,
 * when nothing is live there, the store's legacy socket, where a worker of an older build listens.
 * The command goes only to the first socket that is not shown absent or refused, so it is never
 * delivered twice. When neither is live, the answer is the one that leaves the most doubt: a refusal
 * that does not show its listener gone (`canReplaceListener`) wins, else the current socket's.
 */
export const reachStoreWorker = (
  location: StoreLocation,
  command?: SocketCommand,
  timeout: Duration.Input = "1 second",
): Effect.Effect<WorkerReach, WorkerSocketUnavailable> =>
  Effect.gen(function* () {
    const paths = yield* workerPathsFor(location);
    const current = yield* reachWorker(paths.socket, command, timeout);
    if (isLive(current) || paths.legacy === undefined)
      return { socket: paths.socket, reach: current };
    const legacy = yield* reachWorker(paths.legacy, command, timeout);
    if (
      isLive(legacy) ||
      (canReplaceListener(current) && !canReplaceListener(legacy))
    )
      return { socket: paths.legacy, reach: legacy };
    return { socket: paths.socket, reach: current };
  });

/**
 * Removes a legacy socket file no worker answers on. The caller holds the lifetime lock and saw the
 * connection refused, so no worker of any build owns it; only a socket is removed, never another file.
 */
export const removeStaleLegacySocket = (path: string) =>
  Effect.try({
    try: () => {
      try {
        if (lstatSync(path).isSocket()) unlinkSync(path);
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
      }
    },
    catch: unavailable,
  });

/** An older build's worker answers on the store's legacy socket. */
export const olderBuildWorkerMessage = (legacy: string) =>
  `a worker of an older Neuve build is running on ${legacy}, inside the repository. Stop it with neuve worker stop (this build reaches it there), then start the worker again`;

/** A line longer than this is not a command; the connection is dropped. */
const MAX_LINE = 1_024;

const jobEvents = new EventEmitter();
jobEvents.setMaxListeners(0);
export const jobChanged = (path: string, seq: number, held = false) => {
  jobEvents.emit(`${path}:${seq}`, held ? "held" : "changed");
};

const serveConnection =
  (
    path: string,
    onCommand: (command: string) => string,
    isHeld: (seq: number) => boolean,
    onConnection: Effect.Effect<void>,
  ) =>
  (socket: Socket.Socket) =>
    Effect.gen(function* () {
      const pull = yield* Socket.readerString(socket);
      const writer = yield* socket.writer;
      yield* onConnection;
      let buffer = "";
      while (buffer.length <= MAX_LINE) {
        buffer += (yield* pull).join("");
        let end = buffer.indexOf("\n");
        while (end >= 0) {
          const command = buffer.slice(0, end).trim();
          buffer = buffer.slice(end + 1);
          const subscribe = /^subscribe (\d+)$/.exec(command);
          if (subscribe) {
            const seq = Number(subscribe[1]);
            const changes = yield* Queue.unbounded<string>();
            const event = `${path}:${seq}`;
            const listener = (message: string) =>
              Queue.offerUnsafe(changes, message);
            yield* Effect.acquireRelease(
              Effect.sync(() => jobEvents.on(event, listener)),
              () => Effect.sync(() => jobEvents.off(event, listener)),
            );
            yield* writer.write(`subscribed\n${isHeld(seq) ? "held\n" : ""}`);
            yield* Effect.logInfo("job subscription registered", {
              type: "job.subscription",
              seq,
            });
            // Reading peer close keeps a disconnected subscriber from retaining a server fiber.
            return yield* Effect.raceFirst(
              Effect.forever(
                Effect.flatMap(Queue.take(changes), (message) =>
                  writer.write(`${message}\n`),
                ),
              ),
              Effect.forever(pull),
            );
          }
          const publish = /^publish (\d+)$/.exec(command);
          if (publish) yield* onConnection;
          yield* writer.write(`${publish ? "ok" : onCommand(command)}\n`);
          end = buffer.indexOf("\n");
        }
      }
    }).pipe(Effect.scoped, Effect.ignore);

/**
 * Binds the worker's socket for the enclosing scope and answers each received line with
 * `onCommand`'s reply. Closing the scope stops the server, and Bun's `close` unlinks the socket
 * path at once, so the caller closes it only while it still owns the path.
 */
export const serve = (
  path: string,
  onCommand: (command: string) => string,
  isHeld: (seq: number) => boolean = () => false,
  onConnection: Effect.Effect<void> = Effect.void,
) =>
  Effect.gen(function* () {
    const server = yield* BunSocketServer.make({ path });
    yield* Effect.forkScoped(
      server.run(serveConnection(path, onCommand, isHeld, onConnection)),
    );
  });

/** Socket evidence permits checking ownership, but cannot establish it on its own. */
export const canReplaceListener = (reach: Reach) =>
  reach._tag === "Absent" ||
  (reach._tag === "Refused" && reach.code === "ECONNREFUSED");

/** Never unlink this database: its write lock is the worker's kernel-held lifetime ownership. */
const takeWorkerLock = (file: string) => {
  const db = new Database(file, { create: true });
  try {
    chmodSync(file, 0o600);
    db.exec("PRAGMA busy_timeout=0");
    db.exec("BEGIN IMMEDIATE");
    return db;
  } catch (cause) {
    db.close();
    if (
      cause instanceof Error &&
      "code" in cause &&
      cause.code === "SQLITE_BUSY"
    )
      return undefined;
    throw cause;
  }
};

const lockUnavailable = (cause: unknown) =>
  new WorkerSocketUnavailable({ message: String(cause), cause });
/** Takes `WorkerPaths.lock` for the caller's scope; `undefined` when another worker holds it. */
export const claimWorkerLock = (lock: string) =>
  Effect.try({
    try: () => takeWorkerLock(lock),
    catch: lockUnavailable,
  });

/** A reachable old build still owns its socket; a current build also holds the lifetime lock. */
export const holderGone = (
  location: StoreLocation,
  reach: Reach,
  legacyClaim = false,
) =>
  legacyClaim
    ? Effect.succeed(false)
    : canReplaceListener(reach)
      ? Effect.try({
          try: () => {
            const { lock: path } = workerPathsSync(location);
            try {
              statSync(path);
            } catch (cause) {
              if (
                cause instanceof Error &&
                "code" in cause &&
                cause.code === "ENOENT"
              )
                return true;
              throw cause;
            }
            // A status probe closes its temporary lock in the same synchronous turn.
            const lock = takeWorkerLock(path);
            lock?.close();
            return lock !== undefined;
          },
          catch: lockUnavailable,
        })
      : Effect.succeed(false);

export const olderWorkerMessage = (directory: string) =>
  `Store held by an older worker without a recorded lifetime lock; its socket cannot prove it has stopped. Resume it and run neuve worker stop, or, after it has exited, run neuve worker recover --store ${JSON.stringify(directory)}. Recovery refuses while any process keeps Records open; close other Neuve commands first, then start the worker again.`;

/** Inspect pre-migration stores too, without opening a writable Store connection. */
export const hasLegacyWorkerClaim = (location: StoreLocation) =>
  Effect.try({
    try: () => {
      if (!existsSync(location.database)) return false;
      let legacy = false;
      try {
        return readAsItStands(location.database, (db) => {
          db.exec("BEGIN");
          const table = db
            .prepare(
              "SELECT 1 FROM sqlite_master WHERE type='table' AND name='worker_state'",
            )
            .get();
          if (
            !table ||
            !db.prepare("SELECT 1 FROM worker_state WHERE id=1").get()
          )
            return false;
          const marker = db
            .prepare(
              "SELECT 1 FROM sqlite_master WHERE type='table' AND name='worker_lock_claim'",
            )
            .get();
          legacy =
            !marker ||
            !db.prepare("SELECT 1 FROM worker_lock_claim WHERE id=1").get();
          return legacy;
        }).value;
      } catch (cause) {
        if (cause instanceof StoreChangedDuringRead && legacy) return true;
        throw cause;
      }
    },
    catch: (cause) =>
      cause instanceof StoreChangedDuringRead ? cause : lockUnavailable(cause),
  });

/** A reply alone is insufficient: match the accepting transaction's current claim rows. */
export const acceptedCurrentWorker = (location: StoreLocation, path: string) =>
  Effect.gen(function* () {
    const reach = yield* reachWorker(path, "status", "10 seconds");
    if (reach._tag !== "Answered") return false;
    return yield* Effect.sync(() => {
      let db: Database | undefined;
      try {
        const status = z
          .object({
            pid: z.number().int(),
            socket: z.literal(path),
            startedAt: z.string(),
          })
          .parse(JSON.parse(reach.reply));
        db = openStoreReader(location.database);
        db.exec("BEGIN");
        const row = z
          .object({
            pid: z.number(),
            socket: z.string(),
            started_at: z.string(),
          })
          .nullable()
          .parse(
            db
              .query(
                `SELECT pid, socket, started_at FROM worker_state WHERE id=1
            AND EXISTS (SELECT 1 FROM worker_lock_claim WHERE id=1)`,
              )
              .get(),
          );
        return (
          row !== null &&
          row.pid === status.pid &&
          row.socket === status.socket &&
          row.started_at === status.startedAt
        );
      } catch {
        return false;
      } finally {
        db?.close();
      }
    });
  });

/** Decision 13.19: a refused contender acknowledges only an accepted current winner. */
export const startupMayAcknowledge = (
  location: StoreLocation,
  path: string,
  claimed: boolean,
) => (claimed ? Effect.succeed(true) : acceptedCurrentWorker(location, path));

export class OlderWorkerHeld extends Data.TaggedError("OlderWorkerHeld")<{
  readonly message: string;
}> {}
export const requireCurrentWorkerClaim = (location: StoreLocation) =>
  Effect.gen(function* () {
    if (yield* hasLegacyWorkerClaim(location))
      return yield* new OlderWorkerHeld({
        message: olderWorkerMessage(location.directory),
      });
  });

/**
 * Run without a Store layer. WAL connections retain a database SHARED lock until close.
 * Exclusive locking mode, set before the first access, therefore excludes even a stopped base
 * worker. The lifetime lock also excludes current workers. Neither lock waits or probes a PID.
 */
export const recoverWorker = (location: StoreLocation) =>
  Effect.gen(function* () {
    const paths = yield* workerPathsFor(location);
    const sockets = [paths.socket, ...(paths.legacy ? [paths.legacy] : [])];
    return yield* Effect.try({
      try: () => {
        if (!existsSync(location.database))
          return { recovered: false, message: "No Records store to recover." };
        const lock = takeWorkerLock(paths.lock);
        if (!lock)
          return {
            recovered: false,
            message:
              "Recovery refused: a worker holds its lifetime lock. Resume it and run neuve worker stop.",
          };
        let db: Database | undefined;
        try {
          db = new Database(location.database, { create: false });
          db.exec(
            "PRAGMA busy_timeout=0; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE",
          );
          const row = z
            .object({ socket: z.string() })
            .nullable()
            .parse(
              db.query("SELECT socket FROM worker_state WHERE id=1").get(),
            );
          // An older build recorded the legacy socket; either is this store's.
          if (row && !sockets.includes(row.socket))
            throw new Error(
              "The recorded worker socket differs from this store's socket; recovery refused.",
            );
          db.exec("DELETE FROM worker_state WHERE id=1");
          for (const socket of sockets)
            try {
              unlinkSync(socket);
            } catch (cause) {
              if (!(
                cause instanceof Error &&
                "code" in cause &&
                cause.code === "ENOENT"
              ))
                throw cause;
            }
          db.exec("COMMIT");
          return {
            recovered: true,
            message:
              "Released the older worker's claim after exclusive Records access. Start the worker again to recover its jobs.",
          };
        } catch (cause) {
          if (
            cause instanceof Error &&
            "code" in cause &&
            cause.code === "SQLITE_BUSY"
          )
            return {
              recovered: false,
              message:
                "Recovery refused: Records is still open in another process, which may be a live older worker. Resume it and run neuve worker stop; close other Neuve commands before retrying recovery.",
            };
          throw cause;
        } finally {
          db?.close();
          lock.close();
        }
      },
      catch: lockUnavailable,
    });
  });

/** Send stop once and await that connection's closure; the caller owns any deadline. */
export const stopWorker = (path: string, signal: AbortSignal): Promise<Reach> =>
  new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const socket = createConnection(path);
    let buffer = "";
    let connected = false;
    let reply: string | undefined;
    let failure: Reach | undefined;
    const abort = () => socket.destroy();
    signal.addEventListener("abort", abort, { once: true });
    socket.once("connect", () => {
      connected = true;
      socket.write("stop\n");
    });
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      if (buffer.length > MAX_LINE) return socket.destroy();
      const end = buffer.indexOf("\n");
      if (end >= 0) {
        reply = buffer.slice(0, end);
        buffer = "";
      }
    });
    socket.once("error", (error) => {
      if (connected) return;
      const code =
        "code" in error && typeof error.code === "string"
          ? error.code
          : "UNKNOWN";
      failure =
        code === "ENOENT" ? { _tag: "Absent" } : { _tag: "Refused", code };
    });
    socket.once("close", () => {
      signal.removeEventListener("abort", abort);
      if (signal.aborted) reject(signal.reason);
      else
        resolve(
          failure ??
            (reply === undefined
              ? { _tag: "Unanswered" }
              : { _tag: "Answered", reply }),
        );
    });
  });

export class WorkerSubscriptionLost extends Error {
  readonly _tag = "WorkerSubscriptionLost";
}
export interface JobSubscription {
  next(): Promise<"changed" | "held">;
  close(): void;
}

/** Subscribe before reading the job. Only socket closure or caller cancellation ends the wait. */
export const subscribeJob = async (
  location: StoreLocation,
  seq: number,
  signal?: AbortSignal,
): Promise<JobSubscription> => {
  // A worker of an older build is followed on its legacy socket.
  const { socket: path } = await Effect.runPromise(
    reachStoreWorker(location, undefined, "500 millis"),
  );
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const socket = createConnection(path);
    let buffer = "",
      opened = false,
      ended = false;
    const messages: Array<"changed" | "held"> = [];
    let receive:
      | {
          resolve: (message: "changed" | "held") => void;
          reject: (cause: unknown) => void;
        }
      | undefined;
    const close = () => {
      socket.destroy();
      signal?.removeEventListener("abort", close);
    };
    const endReason = () =>
      signal?.aborted ? signal.reason : new WorkerSubscriptionLost();
    const subscription: JobSubscription = {
      next: () => {
        if (signal?.aborted) return Promise.reject(signal.reason);
        const message = messages.shift();
        if (message) return Promise.resolve(message);
        if (ended) return Promise.reject(endReason());
        return new Promise((resolve, reject) => {
          receive = { resolve, reject };
        });
      },
      close,
    };
    signal?.addEventListener("abort", close, { once: true });
    socket.on("connect", () => socket.write(`subscribe ${seq}\n`));
    socket.on("error", close);
    socket.on("close", () => {
      ended = true;
      signal?.removeEventListener("abort", close);
      if (!opened) reject(endReason());
      receive?.reject(endReason());
    });
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      if (buffer.length > MAX_LINE) return close();
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (line === "subscribed" && !opened) {
          opened = true;
          resolve(subscription);
        } else if (line === "unknown command" && !opened) {
          // An older worker has no outcome pushes. Keep its connection until it exits,
          // then re-read state and start this build without repeatedly probing it.
          opened = true;
          resolve(subscription);
        } else if (line === "changed" || line === "held") {
          if (receive) {
            const next = receive;
            receive = undefined;
            next.resolve(line);
          } else messages.push(line);
        } else close();
      }
    });
  });
};
