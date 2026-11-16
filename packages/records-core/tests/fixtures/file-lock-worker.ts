import { AsyncLocalStorage } from "node:async_hooks";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { mock } from "bun:test";

const [role, root] = process.argv.slice(2);
if (!root) throw new Error("missing fixture directory");
const lock = join(root, "lock");
const gate = () => {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const io = { ...fs };

if (role === "post-link-cleanup-failure") {
  let injected = false;
  mock.module("node:fs/promises", () => ({
    ...io,
    rm: async (path: string, options: Parameters<typeof fs.rm>[1]) => {
      if (
        !injected &&
        path.startsWith(`${lock}.marker-`) &&
        (await io.stat(lock)).isFile()
      ) {
        injected = true;
        throw Object.assign(new Error("post-link sibling cleanup failed"), {
          code: "EIO",
        });
      }
      await io.rm(path, options);
    },
  }));
  const { withFileLock } = await import("../../src/file-lock.ts");
  const first = await withFileLock(lock, async () => 1, 30);
  if (!injected || first !== 1) throw new Error("protected work did not run");
  if ((await io.readdir(root)).includes("lock"))
    throw new Error("canonical lock stranded");
  const second = await withFileLock(lock, async () => 1, 30);
  if (second !== 1) throw new Error("second caller did not acquire");
  console.log(
    JSON.stringify({
      entries: first + second,
      siblings: (await io.readdir(root)).length,
    }),
  );
} else if (role === "dead-owner-replaced") {
  let guards = 0;
  mock.module("node:fs/promises", () => ({
    ...io,
    rename: async (from: string, to: string) => {
      await io.rename(from, to);
      if (to === `${lock}.recovery` && ++guards === 1) {
        const info = await io.stat(lock);
        const marker = await io.readFile(lock, "utf8");
        await io.rename(lock, `${lock}.old`);
        await io.writeFile(lock, marker);
        await io.utimes(lock, info.atime, info.mtime);
      }
    },
  }));
  const { withFileLock } = await import("../../src/file-lock.ts");
  await withFileLock(lock, async () => {});
  await io.rm(`${lock}.old`);
  console.log(JSON.stringify({ guards }));
} else if (role?.startsWith("link-failure-")) {
  const code = role.slice("link-failure-".length);
  mock.module("node:fs/promises", () => ({
    ...io,
    link: async () => {
      throw Object.assign(new Error("link unsupported"), { code });
    },
  }));
  const { withFileLock } = await import("../../src/file-lock.ts");
  let entered = false;
  try {
    await withFileLock(lock, async () => {
      entered = true;
    });
    throw new Error("unexpected success");
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== code)
      throw error;
  }
  if (entered || (await io.readdir(root)).length !== 0)
    throw new Error("unsafe fallback or leaked sibling");
} else if (
  role === "empty-sibling" ||
  role === "before-link" ||
  role === "after-link"
) {
  const pause = async () => {
    console.log("publication paused");
    setInterval(() => {}, 1000);
    await new Promise(() => {});
  };
  mock.module("node:fs/promises", () => ({
    ...io,
    writeFile: async (
      path: string,
      data: string,
      options: Parameters<typeof fs.writeFile>[2],
    ) => {
      if (role === "empty-sibling" && path.includes(".marker-")) {
        const file = await io.open(path, "wx", 0o600);
        try {
          await pause();
        } finally {
          await file.close();
        }
      } else await io.writeFile(path, data, options);
    },
    link: async (from: string, to: string) => {
      if (role === "before-link") await pause();
      await io.link(from, to);
      if (role === "after-link") await pause();
    },
  }));
  const { withFileLock } = await import("../../src/file-lock.ts");
  await withFileLock(lock, async () => {
    throw new Error("unexpected entry");
  });
} else if (role === "interleaving") {
  // Pause B after reading the dead marker, then let A replace it before B's recovery.
  const local = new AsyncLocalStorage<string>();
  const observed = gate(),
    aEntered = gate(),
    recovering = gate(),
    resume = gate(),
    release = gate();
  let reads = 0;
  mock.module("node:fs/promises", () => ({
    ...io,
    readFile: async (...args: Parameters<typeof fs.readFile>) => {
      const value = await io.readFile(...args);
      if (local.getStore() === "B" && args[0] === lock) {
        reads++;
        if (reads === 1) {
          observed.resolve();
          await aEntered.promise;
        } else if (reads === 2) {
          recovering.resolve();
          await resume.promise;
        }
      }
      return value;
    },
    rename: async (from: string, to: string) => {
      await io.rename(from, to);
      // The old helper reaches this hook instead of the guarded second read.
      if (local.getStore() === "B" && from === lock) {
        recovering.resolve();
        await resume.promise;
      }
    },
  }));
  const { withFileLock } = await import("../../src/file-lock.ts");
  const events: string[] = [];
  const tasks: Promise<void>[] = [];
  const enter = async (name: string) => {
    events.push(`${name} entered`);
    if (name === "A") aEntered.resolve();
    await release.promise;
    events.push(`${name} released`);
  };
  try {
    tasks.push(
      local.run("B", () => withFileLock(lock, () => enter("B"), 3000)),
    );
    await observed.promise;
    tasks.push(
      local.run("A", () => withFileLock(lock, () => enter("A"), 3000)),
    );
    await recovering.promise;
    tasks.push(
      local.run("C", () => withFileLock(lock, () => enter("C"), 3000)),
    );
    await Bun.sleep(50);
    if (events.join() !== "A entered") throw new Error(`overlap: ${events}`);
    resume.resolve();
    await Bun.sleep(50);
    if (events.join() !== "A entered") throw new Error(`overlap: ${events}`);
    release.resolve();
    await Promise.all(tasks);
    console.log(JSON.stringify(events));
  } finally {
    aEntered.resolve();
    resume.resolve();
    release.resolve();
    await Promise.allSettled(tasks);
    mock.restore();
  }
} else if (role === "guard-interleaving") {
  // B's delayed cleanup of a dead guard must leave A's replacement guard nonempty.
  const local = new AsyncLocalStorage<string>();
  const observed = gate(),
    aHeld = gate(),
    cleaned = gate(),
    releaseGuard = gate(),
    release = gate(),
    entered = gate();
  const guard = `${lock}.recovery`;
  const oldName = (await io.readdir(guard))[0];
  if (!oldName) throw new Error("missing dead guard");
  mock.module("node:fs/promises", () => ({
    ...io,
    rm: async (path: string, options: Parameters<typeof fs.rm>[1]) => {
      if (local.getStore() === "B" && path === join(guard, oldName)) {
        observed.resolve();
        await aHeld.promise;
        await io.rm(path, options);
        cleaned.resolve();
      } else await io.rm(path, options);
    },
    rename: async (from: string, to: string) => {
      await io.rename(from, to);
      if (local.getStore() === "A" && to === guard) {
        aHeld.resolve();
        await releaseGuard.promise;
      }
    },
  }));
  const { withFileLock } = await import("../../src/file-lock.ts");
  const tasks: Promise<void>[] = [];
  let active = 0,
    maximum = 0;
  const work = async () => {
    active++;
    maximum = Math.max(maximum, active);
    entered.resolve();
    await release.promise;
    active--;
  };
  try {
    tasks.push(local.run("B", () => withFileLock(lock, work, 3000)));
    await observed.promise;
    tasks.push(local.run("A", () => withFileLock(lock, work, 3000)));
    await aHeld.promise;
    const owner = await io.readdir(guard);
    await cleaned.promise;
    tasks.push(local.run("C", () => withFileLock(lock, work, 3000)));
    await Bun.sleep(50);
    if (JSON.stringify(await io.readdir(guard)) !== JSON.stringify(owner))
      throw new Error("replacement recovery guard was removed");
    if (active !== 0) throw new Error("entry while recovery guard held");
    releaseGuard.resolve();
    await entered.promise;
    await Bun.sleep(50);
    if (maximum !== 1) throw new Error(`overlap: ${maximum}`);
    release.resolve();
    await Promise.all(tasks);
    console.log(JSON.stringify({ maximum }));
  } finally {
    aHeld.resolve();
    releaseGuard.resolve();
    release.resolve();
    await Promise.allSettled(tasks);
    mock.restore();
  }
} else if (role === "die-with-guard") {
  mock.module("node:fs/promises", () => ({
    ...io,
    rename: async (from: string, to: string) => {
      await io.rename(from, to);
      if (to === `${lock}.recovery`) {
        console.log("guard held");
        setInterval(() => {}, 1000);
        await new Promise(() => {});
      }
    },
  }));
  const { withFileLock } = await import("../../src/file-lock.ts");
  await withFileLock(lock, async () => {
    throw new Error("unexpected entry");
  });
} else if (role === "stress") {
  const { withFileLock } = await import("../../src/file-lock.ts");
  process.on("message", async () => {
    try {
      await withFileLock(
        lock,
        async () => {
          const active = join(root, "active");
          await io.writeFile(active, String(process.pid), { flag: "wx" });
          try {
            const counter = join(root, "counter");
            const n = Number(await io.readFile(counter, "utf8"));
            await Bun.sleep(2);
            await io.writeFile(counter, String(n + 1));
          } finally {
            await io.rm(active);
          }
        },
        3000,
      );
      process.send?.("ok");
    } catch (error) {
      process.send?.(String(error));
    }
  });
  process.on("disconnect", () => process.exit(0));
  process.send?.("ready");
} else {
  throw new Error(`unknown fixture role: ${role}`);
}
