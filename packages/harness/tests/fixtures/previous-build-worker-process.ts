import { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { Worker, resolveStoreLocation } from "@neuve/records-core";
import { z } from "zod";

// A worker of the build before the socket moved (main 9ac43ecd): it holds the same lifetime lock as
// this build (`<store>/worker.sock.sqlite`) but binds `<store>/worker.sock`, inside the repository.
// Only its socket commands are reproduced; it records no claim row and runs no jobs.
const { repository } = z
  .object({ repository: z.string() })
  .parse(JSON.parse(process.env.NEUVE_SHARED_TEST ?? "{}"));
const location = await Effect.runPromise(resolveStoreLocation(repository));
const path = join(location.directory, "worker.sock");
const lock = new Database(`${path}.sqlite`, { create: true });
lock.exec("PRAGMA busy_timeout=0");
lock.exec("BEGIN IMMEDIATE");
const startedAt = new Date().toISOString();
const listener = Bun.listen({
  unix: path,
  socket: {
    data: (socket, data) => {
      for (const command of data.toString().split("\n").filter(Boolean)) {
        if (command === "stop") {
          socket.write("stopping\n");
          socket.end();
          listener.stop(true);
          rmSync(path, { force: true });
          lock.close();
          console.info(JSON.stringify({ event: "stopped" }));
          setTimeout(() => process.exit(0), 50);
        } else if (command === "status")
          socket.write(
            `${JSON.stringify({
              pid: process.pid,
              startedAt,
              socket: path,
              slots: { interactive: null, background: null, capture: null },
              lastProgressAt: startedAt,
              lastProgress: "claimed",
            } satisfies Worker.WorkerStatusReply)}\n`,
          );
        else socket.write(command === "wake" ? "ok\n" : "unknown command\n");
      }
    },
  },
});
console.info(JSON.stringify({ event: "ready" }));
