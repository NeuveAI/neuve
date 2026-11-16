import { Database } from "bun:sqlite";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  realpathSync,
  lstatSync,
  statSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { Data } from "effect";
import { mkdir } from "node:fs/promises";
import type { Context } from "@earendil-works/chord";

export class SourceOwned extends Data.TaggedError("SourceOwned")<{
  readonly source: string;
  readonly message: string;
}> {
  readonly retryable = true;
}

export class SourceOwnershipUnsupported extends Data.TaggedError(
  "SourceOwnershipUnsupported",
)<{
  readonly source: string;
  readonly message: string;
}> {
  readonly retryable = false;
}

const canonical = (path: string): string => {
  const absolute = resolve(path);
  return existsSync(absolute)
    ? realpathSync(absolute)
    : join(canonical(dirname(absolute)), basename(absolute));
};

const ownershipDirectory = (source: string): string => {
  const path = canonical(source);
  return join(
    dirname(dirname(path)),
    "native-owners",
    basename(dirname(path)),
    basename(path),
  );
};

const device = (path: string): number =>
  existsSync(path) ? statSync(path).dev : device(dirname(path));

const requireSharedFilesystem = (source: string, directory: string): void => {
  if (device(dirname(source)) !== device(directory))
    throw new SourceOwnershipUnsupported({
      source,
      message: "native source and ownership namespace must share a filesystem",
    });
};

const refuseDatabaseAlias = (source: string): void => {
  const path = join(source, "pi.sqlite");
  try {
    const file = lstatSync(path);
    if (file.isSymbolicLink() || file.nlink !== 1)
      throw new SourceOwned({
        source,
        message:
          "native database aliases cannot establish exclusive source ownership",
      });
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error.code === "ENOENT" || error.code === "ENOTDIR")
    )
      return;
    throw error;
  }
};

// Keep the database alive after a bounded caller leaves. Lock files never belong to run disposal.
const owners = new Map<string, SourceOwnership>();

export class SourceOwnership {
  #caller = true;
  readonly #native = new Map<symbol, object>();
  readonly #managed = new WeakSet<object>();

  private constructor(
    readonly source: string,
    private readonly database: Database,
    private readonly key: string,
  ) {}

  static acquire(source: string): SourceOwnership {
    const physicalSource = canonical(source);
    refuseDatabaseAlias(physicalSource);
    // Native component names preserve this volume's equality before the source exists.
    // A fixed database basename leaves room for SQLite sidecars at the component limit.
    const directory = ownershipDirectory(physicalSource);
    requireSharedFilesystem(physicalSource, directory);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const key = realpathSync(directory);
    const busy = () =>
      new SourceOwned({
        source: physicalSource,
        message: "native source still has an execution or disposal owner",
      });
    if (owners.has(key)) throw busy();
    const path = join(key, "owner.sqlite");
    const database = new Database(path);
    try {
      database.run("PRAGMA busy_timeout = 0");
      database.run("BEGIN EXCLUSIVE");
      chmodSync(path, 0o600);
    } catch (error) {
      database.close();
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "SQLITE_BUSY"
      )
        throw busy();
      throw error;
    }
    const owner = new SourceOwnership(physicalSource, database, key);
    owners.set(key, owner);
    return owner;
  }

  assertSource(source: string): void {
    refuseDatabaseAlias(this.source);
    const directory = ownershipDirectory(source);
    requireSharedFilesystem(canonical(source), directory);
    if (
      canonical(directory) !== this.key ||
      owners.get(this.key) !== this ||
      !this.#caller
    )
      throw new SourceOwned({
        source,
        message: "the source ownership is no longer held by this caller",
      });
  }

  assertDisposable(source: string): void {
    this.assertSource(source);
    if (this.#native.size !== 0)
      throw new SourceOwned({
        source,
        message: "native execution has not closed its source",
      });
  }

  async openNative<T extends { close(context: Context): Promise<void> }>(
    path: string,
    open: (path: string) => Promise<T>,
  ): Promise<T> {
    this.assertDisposable(this.source);
    if (path !== ":memory:") await mkdir(dirname(path), { recursive: true });
    const acquisition: {
      state: { kind: "uncertain" } | { kind: "acquired"; storage: T };
    } = {
      state: { kind: "uncertain" },
    };
    const release = this.retainNative(acquisition);
    const raw = await open(path);
    acquisition.state = { kind: "acquired", storage: raw };
    let closing: Promise<void> | undefined;
    const storage = new Proxy(raw, {
      get: (target, key) => {
        if (key === "close")
          return (context: Context) => {
            if (closing === undefined) {
              this.#managed.delete(storage);
              closing = Promise.resolve().then(async () => {
                await target.close(context);
                release();
              });
            }
            return closing;
          };
        const value: unknown = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    this.#managed.add(storage);
    return storage;
  }

  retainNative(resource: object): () => void {
    if (this.#managed.has(resource)) {
      this.assertSource(this.source);
      this.#managed.delete(resource);
    } else this.assertDisposable(this.source);
    const token = Symbol();
    this.#native.set(token, resource);
    return () => {
      this.#native.delete(token);
      this.#releaseIfIdle();
    };
  }

  release(): void {
    this.#caller = false;
    this.#releaseIfIdle();
  }

  #releaseIfIdle(): void {
    if (
      this.#caller ||
      this.#native.size !== 0 ||
      owners.get(this.key) !== this
    )
      return;
    this.database.close();
    owners.delete(this.key);
  }
}
