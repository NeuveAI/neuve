// A socket can disappear before its owning process exits. Test cleanup waits for both.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { z } from "zod";
import { Worker, type StoreLocation } from "../src/index.ts";

export const processAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH")
      return false;
    throw error;
  }
};

export const stopStoreWorker = async (location: StoreLocation) => {
  if (!existsSync(join(location.directory, "worker.log"))) return;
  const socket = await Effect.runPromise(Worker.socketPathFor(location));
  for (let i = 0; i < 100; i++) {
    const status = await Effect.runPromise(
      Worker.reachWorker(socket, "status", "100 millis"),
    );
    if (status._tag !== "Answered") {
      await Bun.sleep(50);
      continue;
    }
    const { pid } = z
      .object({ pid: z.number().int().min(2) })
      .parse(JSON.parse(status.reply));
    try {
      await Effect.runPromise(Worker.reachWorker(socket, "stop"));
      for (let n = 0; n < 200 && processAlive(pid); n++) await Bun.sleep(25);
      if (processAlive(pid))
        throw new Error(`store worker ${pid} did not exit after stop`);
    } finally {
      if (processAlive(pid)) {
        process.kill(pid, "SIGTERM");
        for (let n = 0; n < 100 && processAlive(pid); n++) await Bun.sleep(25);
        if (processAlive(pid)) process.kill(pid, "SIGKILL");
      }
    }
    return;
  }
  if (Worker.isLive(await Effect.runPromise(Worker.reachWorker(socket))))
    throw new Error("store worker did not answer cleanup");
};
