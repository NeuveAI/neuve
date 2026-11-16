import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  unlinkSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
  watch,
  type FSWatcher,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { Cause, Data, Effect, Queue, Stream } from "effect";
import type { z } from "zod";
import {
  accountStoreRefusalMessage,
  type AccountStoreRefusal,
} from "../errors.ts";
import { safeRead, sayOnce } from "@neuve/records-schema";

export class StoreError extends Data.TaggedError("AccountStoreError")<{
  readonly message: string;
  readonly refusal?: AccountStoreRefusal;
}> {}
export class UnreadableFile extends StoreError {}

export const neuveFolder = (home: string) =>
  process.platform === "darwin"
    ? join(home, "Library", "Application Support", "Neuve")
    : join(home, ".config", "neuve");
export const accountsPath = (home: string) =>
  join(neuveFolder(home), "accounts", "records");
export const statusesPath = (home: string) =>
  join(neuveFolder(home), "accounts", "status.json");

export function privatePath(path: string, directory: boolean): void {
  if (directory) return folderPath(path, "private");
  const info = lstatSync(path);
  if (
    info.isSymbolicLink() ||
    !info.isFile() ||
    (info.mode & 0o077) !== 0 ||
    (process.getuid !== undefined && info.uid !== process.getuid())
  )
    throw new StoreError({
      message: `${path} must be a file readable only by you (0600).`,
    });
}

function refuseFolder(
  folder: string,
  problem: AccountStoreRefusal["problem"],
): never {
  const refusal = { folder, problem };
  throw new StoreError({
    message: accountStoreRefusalMessage(refusal),
    refusal,
  });
}

function folderPath(path: string, access: "private" | "owner-writable"): void {
  const info = lstatSync(path);
  if (info.isSymbolicLink()) refuseFolder(path, { kind: "symbolic-link" });
  if (!info.isDirectory()) refuseFolder(path, { kind: "not-folder" });
  if (access === "private" && (info.mode & 0o077) !== 0) {
    const permission =
      (info.mode & 0o044) !== 0
        ? "read"
        : (info.mode & 0o022) !== 0
          ? "written"
          : "accessed";
    const mode = (info.mode & 0o777).toString(8).padStart(4, "0");
    refuseFolder(path, { kind: "private-permissions", permission, mode });
  }
  if (access === "owner-writable" && (info.mode & 0o022) !== 0)
    refuseFolder(path, { kind: "writable-by-others" });
  if (process.getuid !== undefined && info.uid !== process.getuid())
    refuseFolder(path, { kind: "wrong-owner" });
}

export function privateParents(home: string, path: string): void {
  const root = resolve(neuveFolder(home));
  let current = resolve(path);
  if (current !== root && !current.startsWith(`${root}/`))
    throw new StoreError({ message: "The path is outside Neuve's folder." });
  for (;;) {
    if (existsSync(current))
      folderPath(current, current === root ? "owner-writable" : "private");
    if (current === root) return;
    current = dirname(current);
  }
}

export function privateDirectory(home: string, path: string): void {
  privateParents(home, path);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  privateParents(home, path);
}

/** Reject before schema parsing, whose diagnostics can include submitted values. */
export function refuseCredentials(value: unknown, field = "accounts"): void {
  if (
    typeof value === "string" &&
    (/^sk-ant-[A-Za-z0-9_-]{20,}$/.test(value.trim()) ||
      /^sk-[A-Za-z0-9_-]{20,}$/.test(value.trim()) ||
      /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/.test(value.trim()))
  )
    throw new StoreError({
      message: `The field ${field} must be a reference, never a credential.`,
    });
  if (Array.isArray(value))
    value.forEach((item, i) => refuseCredentials(item, `${field}[${i}]`));
  else if (value !== null && typeof value === "object")
    for (const [key, item] of Object.entries(value)) {
      // Keys may also contain a submitted credential. Never echo an unknown key.
      refuseCredentials(key, `${field} field name`);
      refuseCredentials(
        item,
        `${field}.${/^[a-zA-Z][a-zA-Z0-9]*$/.test(key) ? key : "field"}`,
      );
    }
}

export function readJson<A>(
  home: string,
  path: string,
  schema: z.ZodType<A>,
): A | undefined {
  return readStoredJson(home, path, schema)?.data;
}

export function storeNotice(path: string, message: string): void {
  sayOnce(`account-store:${path}:${message}`, `${path} ${message}`, (line) => {
    try {
      process.stderr.write(`${line}\n`);
    } catch {}
  });
}

/** Keep the same raw snapshot for compatible write-back as for the validated read. */
export function readStoredJson<A>(
  home: string,
  path: string,
  schema: z.ZodType<A>,
): { data: A; stored: unknown } | undefined {
  privateParents(home, dirname(path));
  if (!existsSync(path)) return undefined;
  let value: unknown;
  try {
    privatePath(path, false);
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if (missing(error)) return undefined;
    if (error instanceof StoreError) throw error;
    if (error instanceof SyntaxError)
      throw new UnreadableFile({ message: `${path} is not valid JSON.` });
    throw new StoreError({ message: `${path} could not be read.` });
  }
  refuseCredentials(value);
  const parsed = safeRead(schema, value, { source: path });
  if (!parsed.success)
    throw new UnreadableFile({
      message: `${path} is not a valid Neuve account file.`,
    });
  return { data: parsed.data, stored: value };
}

/** Publish a status snapshot with an atomic rename. */
export function writeJson(home: string, path: string, value: unknown): void {
  refuseCredentials(value);
  privateDirectory(home, dirname(path));
  if (existsSync(path)) privatePath(path, false);
  const temporary = join(dirname(path), `.${process.pid}-${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, `${JSON.stringify(value)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function missing(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
export function unlinkIfPresent(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if (!missing(error)) throw error;
  }
}

export const storeIO = <A>(run: () => A) =>
  Effect.try({
    try: run,
    catch: (error) =>
      error instanceof StoreError
        ? error
        : new StoreError({
            message: "Neuve could not access its account files.",
          }),
  });

type FolderSubscriber = {
  changed: () => void;
  failed: (error: unknown) => void;
};
const folderWatches = new Map<
  string,
  { subscribers: Set<FolderSubscriber>; attach: () => void; close: () => void }
>();

/** Resolve through the nearest existing parent without creating the requested folder. */
export function folderKey(folder: string): string {
  const requested = resolve(folder);
  let parent = requested;
  while (!existsSync(parent)) parent = dirname(parent);
  return join(realpathSync(parent), relative(parent, requested));
}

/** One watcher per real folder per process; the final unsubscribe closes it. */
export function watchFolder(
  folder: string,
  changed: () => void,
  failed: (error: unknown) => void,
): () => void {
  const key = folderKey(folder);
  const subscriber = { changed, failed };
  let shared = folderWatches.get(key);
  if (shared === undefined) {
    const subscribers = new Set<FolderSubscriber>();
    let watcher: FSWatcher | undefined;
    let watched: string | undefined;
    const fail = (error: unknown) => {
      for (const listener of [...subscribers]) listener.failed(error);
    };
    const attach = () => {
      let target = key;
      while (!existsSync(target)) target = dirname(target);
      if (target === watched) return;
      watcher?.close();
      watched = target;
      watcher = watch(target, () => {
        if (subscribers.size === 0) return;
        try {
          // macOS watch event loss can miss a change right after re-attach; checkTurn and the next change cover it.
          attach();
          for (const listener of [...subscribers]) listener.changed();
        } catch (error) {
          fail(error);
        }
      });
      watcher.on("error", fail);
    };
    attach();
    shared = { subscribers, attach, close: () => watcher?.close() };
    folderWatches.set(key, shared);
  }
  shared.attach();
  shared.subscribers.add(subscriber);
  try {
    // Reading after registration covers a write just before subscription.
    changed();
  } catch (error) {
    failed(error);
  }
  const entry = shared;
  return () => {
    entry.subscribers.delete(subscriber);
    if (entry.subscribers.size === 0 && folderWatches.get(key) === entry) {
      folderWatches.delete(key);
      entry.close();
    }
  };
}

export const folderChanges = (
  folder: string,
): Stream.Stream<void, StoreError> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const queue = yield* Effect.acquireRelease(
        Queue.make<void, StoreError>(),
        Queue.shutdown,
      );
      yield* Effect.acquireRelease(
        storeIO(() =>
          watchFolder(
            folder,
            () => {
              Queue.offerUnsafe(queue, undefined);
            },
            () => {
              Queue.failCauseUnsafe(
                queue,
                Cause.fail(
                  new StoreError({ message: "The account file watch failed." }),
                ),
              );
            },
          ),
        ),
        (close) => Effect.sync(close),
      );
      return Stream.fromQueue(queue);
    }),
  );
