import { chmodSync, existsSync, unlinkSync } from "node:fs";
import { createConnection, createServer, type Socket } from "node:net";
import { Effect } from "effect";
import { Worker, type StoreLocation } from "@neuve/records-core";
import { claimWorkerLock } from "../../../packages/records-core/src/worker-socket.ts";
import { REVIEW_DESK_COMMAND } from "./review-desk-config.ts";
import { quote } from "./shell-quote.ts";

const addressPattern = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})\/$/;

/**
 * The desk's socket, beside the worker's in the user's private socket folder:
 * `/tmp/neuve-<uid>/<hash>.desk.sock`. Its lifetime lock is `<socket>.sqlite`.
 */
export const deskSocket = async (location: StoreLocation) =>
  (await Effect.runPromise(Worker.socketPathFor(location)))
    .replace(/\.sock$/, ".desk.sock")
    .replace(/\/worker\.desk\.sock$/, "/desk.sock");

/**
 * The live desk's address, read from its socket: one connection, which the desk answers once it
 * serves. Anything else (no socket, no answer, a malformed or oversized one) means no live desk.
 */
export const liveDesk = (
  path: string,
  timeoutMs = 1000,
): Promise<string | undefined> =>
  new Promise((resolve) => {
    const connection = createConnection(path);
    let data = "";
    let finished = false;
    const finish = (address?: string) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      connection.destroy();
      resolve(address);
    };
    const timer = setTimeout(() => finish(), timeoutMs > 0 ? timeoutMs : 1000);
    connection.on("error", () => finish());
    connection.on("data", (chunk: Buffer) => {
      data += chunk.toString();
      if (data.length > 1024) return finish();
      if (!data.includes("\n")) return;
      const address = data.slice(0, data.indexOf("\n"));
      const port = addressPattern.exec(address)?.[1];
      finish(port !== undefined && Number(port) <= 65535 ? address : undefined);
    });
    connection.on("end", () => finish());
    connection.on("close", () => finish());
  });

/**
 * One desk per repository store. The claim is the worker's kind of lifetime lock (record 0016's
 * interim rule until the budget host's shared-work helper exists): a SQLite write lock the kernel
 * releases when the process ends, however it ends, so a dead desk's claim needs no cleanup and has
 * no process-ID check or lease. Only the lock's holder removes a stale socket and binds the path.
 * Undefined when another desk holds it.
 */
export const claimDesk = async (path: string) => {
  const lock = Effect.runSync(claimWorkerLock(`${path}.sqlite`));
  if (lock === undefined) return undefined;
  const ready = Promise.withResolvers<string>();
  const clients = new Set<Socket>();
  const listener = createServer((socket) => {
    clients.add(socket);
    socket.on("error", () => socket.destroy());
    socket.once("close", () => clients.delete(socket));
    void ready.promise.then((address) => {
      if (!socket.destroyed) socket.end(`${address}\n`);
    });
  });
  const closeListener = () =>
    new Promise<void>((resolve) => listener.close(() => resolve()));
  try {
    if (existsSync(path)) unlinkSync(path);
    await new Promise<void>((resolve, reject) => {
      listener.once("error", reject);
      listener.listen(path, resolve);
    });
    chmodSync(path, 0o600);
    return {
      /** Answers every waiting and later connection with the desk's address. */
      publish: (address: string) => ready.resolve(address),
      async close() {
        ready.resolve("");
        for (const client of clients) client.destroy();
        await closeListener();
        lock.close();
      },
    };
  } catch (error) {
    for (const client of clients) client.destroy();
    await closeListener();
    lock.close();
    throw error;
  }
};

/** What `neuve review` prints after queueing: the cycle on the live desk, or how to open one. */
export const deskLinkLine = async (
  location: StoreLocation,
  cycleId: string,
  /** The repository to name in the command, when the request named one with --repo. */
  repository?: string,
) => {
  const address = await deskSocket(location)
    .then((path) => liveDesk(path))
    .catch(() => undefined);
  if (address !== undefined) return `Review desk: ${address}cycles/${cycleId}`;
  // A command on a line of its own, so copying the line copies nothing but the command.
  return repository === undefined
    ? `To open it, run neuve review ${REVIEW_DESK_COMMAND}.`
    : `To open it, run:\nneuve review ${REVIEW_DESK_COMMAND} --repo ${quote(repository)}`;
};
