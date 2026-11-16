import { afterAll, afterEach } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import { processAlive } from "./worker-process.ts";

const signal = (pid: number, value: NodeJS.Signals) => {
  try {
    process.kill(pid, value);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH"))
      throw error;
  }
};

const createOwner = async () => {
  // Keep the Unix socket below macOS's pathname limit even with a long TMPDIR.
  const directory = mkdtempSync(`/tmp/neuve-fixtures-${process.pid}-`);
  const groups = new Set<number>();
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  let closed = false;
  const pids = () =>
    readdirSync(directory)
      .filter((name) => name.endsWith(".pid"))
      .map((name) => Number(name.slice(0, -4)));
  const owner = {
    env: { NEUVE_FIXTURE_OWNER: directory },
    pids,
    child(pid: number | undefined) {
      if (pid === undefined) return;
      groups.add(pid);
      writeFileSync(join(directory, `${pid}.pid`), String(pid));
      const audit = process.env.NEUVE_FIXTURE_AUDIT_DIRECTORY;
      if (audit !== undefined)
        writeFileSync(join(audit, `${pid}.pid`), String(pid));
    },
    async close() {
      if (!closed) {
        closed = true;
        // Only detached groups created and registered by this test are signalled.
        for (const pid of groups) signal(-pid, "SIGKILL");
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        for (const pid of pids()) if (processAlive(pid)) signal(pid, "SIGTERM");
        for (let n = 0; n < 100 && pids().some(processAlive); n++)
          await Bun.sleep(10);
      }
      owner.assertStopped();
    },
    assertStopped() {
      const survivors = pids().filter(processAlive);
      for (const pid of survivors) signal(pid, "SIGKILL");
      if (survivors.length > 0)
        throw new Error(
          `fixture processes outlived their test: ${survivors.join(", ")}`,
        );
    },
    directory,
  };
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(join(directory, "owner.sock"), resolve);
  });
  return owner;
};

/** Hooks also run after Bun cancels a timed-out test, whose finally may never finish. */
export const workerSuite = () => {
  const owners: Array<Awaited<ReturnType<typeof createOwner>>> = [];
  const start = async () => {
    const owner = await createOwner();
    owners.push(owner);
    return owner;
  };
  afterEach(async () => {
    for (const owner of owners) await owner.close();
  });
  afterAll(() => {
    try {
      // Check again at suite end, including workers that registered during cleanup.
      for (const owner of owners) owner.assertStopped();
    } finally {
      for (const owner of owners)
        rmSync(owner.directory, { recursive: true, force: true });
    }
  });
  return { start };
};
