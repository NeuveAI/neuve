// Budget hosts of each generation, from the v1 admit, capacity and release schemas frozen at
// a96fc634. A "strict" host reads them with `.parse`, as hosts before 10 November did; a
// "compatible" host with `readData`, which drops a newer build's additive keys. Both answer
// capacity without `readings`. A "refusing" host knows readings (its capacity says `readings: 1`)
// and refuses every admit, as a full queue does.
import { readData } from "@neuve/records-core";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import { z } from "zod";

const Priority = z.strictObject({
  class: z
    .enum(["interactive", "preparation", "speculation"])
    .default("interactive"),
  position: z
    .enum(["understand", "continuation", "started", "new"])
    .default("new"),
  stage: z.number().int().min(0).max(100).default(0),
});
export const FrozenRequest = z.strictObject({
  queuedAt: z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER)
    .optional(),
  owner: z.string().min(1).max(128),
  priority: Priority,
  resource: z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("cpu"),
      permits: z.number().int().min(1).max(1024),
    }),
    z.strictObject({
      kind: z.literal("provider"),
      account: z.string().regex(/^[a-f0-9]{64}$/),
    }),
  ]),
});
const Observation = z.strictObject({
  durationMs: z.number().min(0).max(86_400_000),
  firstTokenMs: z.number().min(0).max(86_400_000).optional(),
  throttled: z.boolean().default(false),
  retryAfter: z.boolean().default(false),
});
const Message = z.discriminatedUnion("kind", [
  z.strictObject({
    version: z.literal(1),
    kind: z.literal("admit"),
    request: FrozenRequest,
  }),
  z.strictObject({
    version: z.literal(1),
    kind: z.literal("release"),
    observation: Observation.optional(),
  }),
  z.strictObject({ version: z.literal(1), kind: z.literal("capacity") }),
]);

/**
 * Listens at `directory`'s budget socket; `admitted` holds each request it accepted, as read, and
 * `exchanges` the kind of each connection's first message.
 */
export const frozenHost = async (
  directory: string,
  read: "strict" | "compatible" | "refusing",
) => {
  const admitted: Array<z.infer<typeof FrozenRequest>> = [];
  const sockets = new Set<Socket>();
  const exchanges: string[] = [];
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());
    socket.once("data", (chunk) => {
      const line = chunk.toString().split("\n")[0] ?? "";
      try {
        const raw: unknown = JSON.parse(line);
        exchanges.push(z.object({ kind: z.string() }).parse(raw).kind);
        const message =
          read === "strict"
            ? Message.parse(raw)
            : readData(Message, raw, { source: "frozen-host" });
        if (message.kind === "capacity") {
          socket.end(
            `${JSON.stringify({ kind: "numbers", numbers: { threads: 2, reserve: 1, backgroundCap: 1, ...(read === "refusing" ? { readings: 1 } : {}) } })}\n`,
          );
          return;
        }
        if (message.kind !== "admit" || read === "refusing")
          throw new Error("Refused");
        admitted.push(message.request);
        socket.write(`${JSON.stringify({ kind: "grant", permits: 1 })}\n`);
        socket.once("data", () =>
          socket.end(`${JSON.stringify({ kind: "numbers", numbers: {} })}\n`),
        );
      } catch {
        socket.end(`${JSON.stringify({ kind: "error" })}\n`);
      }
    });
  });
  await new Promise<void>((resolve) =>
    server.listen(join(directory, "budget.sock"), resolve),
  );
  return {
    admitted,
    exchanges,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
};
