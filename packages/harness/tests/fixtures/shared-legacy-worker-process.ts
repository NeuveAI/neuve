import { join } from "node:path";
import { Effect } from "effect";
import { resolveStoreLocation } from "@neuve/records-core";
import { z } from "zod";

const { repository } = z
  .object({ repository: z.string() })
  .parse(JSON.parse(process.env.NEUVE_SHARED_TEST ?? "{}"));
const location = await Effect.runPromise(resolveStoreLocation(repository));
// Older builds bound `<store>/worker.sock`, inside the repository.
const path = join(location.directory, "worker.sock");
const listener = Bun.listen({
  unix: path,
  socket: {
    data: (socket) => {
      socket.write("legacy\n");
    },
  },
});
console.info(JSON.stringify({ event: "ready" }));
for await (const _ of Bun.stdin.stream()) break;
listener.stop(true);
