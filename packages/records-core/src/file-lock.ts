import { randomUUID } from "node:crypto";
import {
  link,
  open,
  stat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";

export const processAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
};

const contents = async (path: string) => {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
};

// Only an empty guard can be removed. A newly published guard is already nonempty.
const removeEmptyGuard = async (guard: string) => {
  try {
    await rmdir(guard);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTEMPTY" && code !== "EEXIST")
      throw error;
  }
};

const ownerOf = (text: string) => {
  const match = /^([1-9]\d*)(?: |$)/.exec(text);
  const owner = match ? Number(match[1]) : 0;
  return Number.isSafeInteger(owner) ? owner : 0;
};
const observed = async (path: string) => {
  try {
    const info = await stat(path);
    const text = await contents(path);
    return text === undefined
      ? undefined
      : { text, ino: info.ino, dev: info.dev, mtimeMs: info.mtimeMs };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
};
type Observation = NonNullable<Awaited<ReturnType<typeof observed>>>;
const recoverable = (seen: Observation) => {
  const owner = ownerOf(seen.text);
  // Even an incomplete PID-bearing marker belongs to a live writer until it exits.
  return owner > 0 && !processAlive(owner);
};
// Cleanup actions all run, and a cleanup failure cannot hide the original error.
const withCleanup = async <A>(
  work: () => Promise<A>,
  actions: ReadonlyArray<() => Promise<unknown>>,
): Promise<A> => {
  const result: { readonly value: A } | { readonly error: unknown } =
    await work().then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
  const errors: unknown[] = "error" in result ? [result.error] : [];
  for (const action of actions) {
    try {
      await action();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 1)
    throw new AggregateError(errors, "Lock operation and cleanup failed");
  if (errors.length) throw errors[0];
  if ("error" in result) throw result.error;
  return result.value;
};
type Ownership = {
  readonly handle: Awaited<ReturnType<typeof open>>;
  readonly ino: number;
  readonly dev: number;
  readonly marker: string;
};
const publish = async (lock: string, marker: string): Promise<Ownership> => {
  const staged = `${lock}.marker-${process.pid}-${randomUUID()}`;
  let receipt: Ownership | undefined;
  let handle: Ownership["handle"] | undefined;
  return withCleanup(async () => {
    await writeFile(staged, marker, { flag: "wx", mode: 0o600 });
    handle = await open(staged, "r");
    const info = await handle.stat();
    // No partial canonical marker, even on a filesystem that refuses hard links.
    await link(staged, lock);
    receipt = { handle, ino: info.ino, dev: info.dev, marker };
    return receipt;
  }, [
    async () => {
      try {
        await rm(staged, { force: true });
      } catch (error) {
        if (!receipt) throw error;
      }
    },
    async () => {
      if (!receipt) await handle?.close();
    },
  ]);
};

const release = async (lock: string, receipt: Ownership) =>
  withCleanup(async () => {
    let text: string | undefined;
    try {
      text = await contents(lock);
    } catch (error) {
      return withCleanup(async () => {
        throw error;
      }, [
        async () => {
          const info = await stat(lock);
          if (info.ino !== receipt.ino || info.dev !== receipt.dev)
            throw new Error("Lock ownership was lost before release");
          await rm(lock, { force: true });
        },
      ]);
    }
    if (text === undefined) return;
    if (text !== receipt.marker)
      throw new Error("Lock ownership was lost before release");
    await rm(lock, { force: true });
  }, [() => receipt.handle.close()]);

const recover = async (lock: string, seen: Observation, marker: string) => {
  const guard = `${lock}.recovery`;
  const staged = await mkdtemp(`${guard}-`);
  const name = marker.trimEnd();
  return withCleanup(async () => {
    await writeFile(join(staged, name), marker, { flag: "wx", mode: 0o600 });
    try {
      // rename cannot replace a nonempty directory, so guard publication is exclusive.
      await rename(staged, guard);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOTEMPTY" && code !== "EEXIST") throw error;
      let owners: string[];
      try {
        owners = await readdir(guard);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
        throw error;
      }
      for (const owner of owners) {
        const match = /^([1-9]\d*) [0-9a-f-]{36}$/.exec(owner);
        if (match && !processAlive(Number(match[1])))
          // This filename is never reused. A delayed cleaner cannot unlink a new owner.
          await rm(join(guard, owner), { force: true });
      }
      await removeEmptyGuard(guard);
      return false;
    }
    await withCleanup(async () => {
      // All recoverers hold this guard. Until removal the dead marker excludes acquirers.
      const current = await observed(lock);
      if (
        current &&
        current.ino === seen.ino &&
        current.dev === seen.dev &&
        current.text === seen.text &&
        current.mtimeMs === seen.mtimeMs &&
        recoverable(current)
      )
        await rm(lock, { force: true });
    }, [
      () => rm(join(guard, name), { force: true }),
      () => removeEmptyGuard(guard),
    ]);
    return true;
  }, [() => rm(staged, { recursive: true, force: true })]);
};

/**
 * Exclusive PID/UUID lock shared with the stack store. Recovery rechecks the dead marker under
 * a recovery guard; release retains the published inode and removes only our marker or a matching inode after a read failure. Work must await publication before return.
 * An ownerless legacy lock is never taken over: its writer may still be alive between create and write.
 */
export class FileLocked extends Error {
  constructor(
    readonly owner: number,
    lock: string,
  ) {
    super(
      owner === 0
        ? `the lock ${lock} has no recorded owner and was most likely left by an older Neuve build; it is safe to remove once no older Neuve is running`
        : `the file is locked by process ${owner}`,
    );
  }
}

export const withFileLock = async <A>(
  lock: string,
  work: () => Promise<A>,
  waitMs = 120_000,
  signal?: AbortSignal,
): Promise<A> => {
  await mkdir(dirname(lock), { recursive: true, mode: 0o700 });
  const marker = `${process.pid} ${randomUUID()}\n`;
  const deadline = Date.now() + waitMs;
  let receipt: Ownership;
  let owner = 0;
  let attempted = false;
  for (;;) {
    signal?.throwIfAborted();
    if (attempted && Date.now() >= deadline) throw new FileLocked(owner, lock);
    attempted = true;
    try {
      receipt = await publish(lock, marker);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const seen = await observed(lock);
      owner = seen ? ownerOf(seen.text) : 0;
      if (seen !== undefined && recoverable(seen)) {
        if (await recover(lock, seen, marker)) continue;
      }
      if (Date.now() >= deadline) throw new FileLocked(owner, lock);
      await new Promise((resolve) =>
        setTimeout(
          resolve,
          Math.min(
            100 + Math.random() * 150,
            Math.max(1, deadline - Date.now()),
          ),
        ),
      );
    }
  }
  return withCleanup(async () => {
    signal?.throwIfAborted();
    return work();
  }, [() => release(lock, receipt)]);
};
