import { safeRead } from "@neuve/records-schema";
import { readData } from "./compatible-read.ts";
import { createHash, randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { dirname, join } from "node:path";
import { Effect } from "effect";
import { budgetDirectory } from "./budget-directory.ts";
import { resolveStoreLocation } from "./location.ts";
import { acquireConnect } from "./socket-connect-gate.ts";
import {
  SHARED_WORK_LINE_BYTES,
  SharedWorkMessage,
  SharedWorkReply,
} from "./shared-work-protocol.ts";
import type {
  ClaimEvent,
  SharedClaim,
  SharedOutcome,
  PublishedSharedOutcome,
  SharedWorkTransport,
} from "./shared-work.ts";
export { budgetDirectory } from "./budget-directory.ts";

/** Checkout, worktree and symlink aliases resolve to the real Git common directory. */
export const canonicalStoreIdentity = async (
  repository: string,
): Promise<string> =>
  realpath(
    dirname(
      (await Effect.runPromise(resolveStoreLocation(repository))).directory,
    ),
  );
const digest = (text: string) =>
  createHash("sha256").update(text).digest("hex");

/** Claims and queries never share connect slots. The host answers a claim at once
 * but may hold an ownership or delivery query until re-declaration closes, so a
 * shared pool would let queries keep a re-declaring holder from reaching the host
 * inside its window, and a second caller would run the same work.
 *
 * The sizes leave room on the socket's accept queue (128 on macOS) for the budget
 * client in `packages/harness/src/budget/local.ts`, which connects to the same
 * socket. Its own gate, built on the scheduler lane's branch, allows at most 33
 * unaccepted connections per process; until that gate lands, the budget client's
 * connections are unbounded and this arithmetic does not hold. With it, shared work
 * holds 16 + 8 = 24, so one process has at most 24 + 33 = 57 unaccepted, and two
 * processes stalled by the same host pause 114, under 128. Three processes in one
 * stall can still overflow, which is accepted.
 *
 * The failure is total once the queue fills. Measured on this Mac on 12 November
 * 2026, with the host paused for 300 ms: with two pools of 32 and 100 other
 * connections already queued, 472 of 500 claims were floors. At these sizes, with
 * 500 claims and 200 queries, there were no floors with 100 other connections
 * already queued (24 + 100 = 124), and with 110 the queue overflowed.
 *
 * Claims are answered at once, so 16 claim slots cost nothing measurable: 500 claims
 * in one tick took 29–65 ms with 32 slots and 31–53 ms with 16 (this Mac, same day).
 * The smaller pool does lengthen the wait on a hung host, which fills its queue by
 * 16 abandoned claims per 2-second timer: measured the same day, 300 claims against
 * a host hung for 30 seconds gave 16 floors every 2 seconds and the last 188 at 16
 * seconds, so callers learn it is unreachable after up to about 16 seconds (it was
 * about 2). */
export const SHARED_WORK_CLAIM_POOL = "shared-work-claim";
export const SHARED_WORK_CLAIM_SLOTS = 16;
export const SHARED_WORK_QUERY_POOL = "shared-work-query";
export const SHARED_WORK_QUERY_SLOTS = 8;
const claimPool = {
  name: SHARED_WORK_CLAIM_POOL,
  size: SHARED_WORK_CLAIM_SLOTS,
};
const queryPool = {
  name: SHARED_WORK_QUERY_POOL,
  size: SHARED_WORK_QUERY_SLOTS,
};

/** Clients only connect. The optional callback is the budget's existing recovery path. */
export function sharedWorkSocket(
  input: {
    readonly directory?: string;
    readonly recover?: () => Promise<void>;
    readonly deliveryAcknowledgement?: boolean;
    readonly onHost?: (host: string) => void;
  } = {},
): SharedWorkTransport {
  return {
    ...(input.recover ? { recover: input.recover } : {}),
    claim: async (request) => {
      request.signal.throwIfAborted();
      const path = join(input.directory ?? budgetDirectory(), "budget.sock");
      // The slot bounds this attempt until the host first answers. Every way the attempt ends
      // releases it: that reply, close, error, the caller's close, abort or the 2-second timer.
      const release = await acquireConnect(path, request.signal, claimPool);
      return new Promise((resolve, reject) => {
        let socket: Socket;
        try {
          request.signal.throwIfAborted();
          socket = createConnection(path);
        } catch (cause) {
          release();
          throw cause;
        }
        const queue: ClaimEvent[] = [];
        let receiver: ((event: ClaimEvent) => void) | undefined;
        let opened = false,
          ended = false,
          buffer = "";
        const push = (event: ClaimEvent) => {
          if (receiver) {
            const receive = receiver;
            receiver = undefined;
            receive(event);
          } else queue.push(event);
        };
        let acknowledge: (() => void) | undefined;
        const close = () => {
          socket.destroy();
          release();
          request.signal.removeEventListener("abort", abort);
        };
        const abort = () => {
          close();
          if (!opened) reject(request.signal.reason);
        };
        request.signal.addEventListener("abort", abort, { once: true });
        const lost = () => {
          release();
          if (ended) return;
          ended = true;
          clearTimeout(connecting);
          request.signal.removeEventListener("abort", abort);
          if (!opened) {
            opened = true;
            resolve({ kind: "floor", reason: "unreachable" });
          } else push({ kind: "lost" });
          acknowledge?.();
        };
        const connecting = setTimeout(() => {
          socket.destroy();
          release();
        }, 2000);
        socket.on("error", () => {
          socket.destroy();
          release();
        });
        socket.on("close", lost);
        socket.on("connect", () => {
          socket.write(
            `${JSON.stringify(
              SharedWorkMessage.parse({
                version: 1,
                kind: "claim",
                store: digest(request.store),
                key: digest(request.key),
                insideGrant: request.insideGrant,
                redeclare: request.redeclare,
                ...(input.deliveryAcknowledgement
                  ? { deliveryAcknowledgement: true }
                  : {}),
              }),
            )}\n`,
          );
        });
        const claim: SharedClaim = {
          withdraw: () => {
            if (!ended && !socket.destroyed)
              socket.write(
                `${JSON.stringify(SharedWorkMessage.parse({ version: 1, kind: "withdraw" }))}\n`,
              );
          },
          next: () => {
            const event = queue.shift();
            return event
              ? Promise.resolve(event)
              : ended
                ? Promise.resolve({ kind: "lost" })
                : new Promise((resolve) => {
                    receiver = resolve;
                  });
          },
          settle: (outcome, publication) =>
            new Promise<void>((resolve) => {
              if (ended || socket.destroyed) {
                resolve();
                return;
              }
              acknowledge = resolve;
              socket.write(
                `${JSON.stringify(SharedWorkMessage.parse({ version: 1, kind: "settle", outcome, publication }))}\n`,
              );
            }),
          close,
        };
        socket.on("data", (chunk) => {
          buffer += chunk.toString();
          let index: number;
          while ((index = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, index);
            buffer = buffer.slice(index + 1);
            if (Buffer.byteLength(line) > SHARED_WORK_LINE_BYTES) {
              socket.destroy();
              return;
            }
            const parsed = safeRead(
              SharedWorkReply,
              (() => {
                try {
                  return JSON.parse(line);
                } catch {
                  return undefined;
                }
              })(),
              {
                source: join(
                  input.directory ?? budgetDirectory(),
                  "budget.sock",
                ),
              },
            );
            if (!parsed.success) {
              socket.destroy();
              return;
            }
            // The host's first reply ends the attempt, and with it the 2-second timer.
            clearTimeout(connecting);
            release();
            const reply = parsed.data;
            if (!opened) {
              opened = true;
              if (
                reply.kind === "error" ||
                (input.deliveryAcknowledgement &&
                  (!("host" in reply) || !reply.host))
              ) {
                resolve({ kind: "floor", reason: "old-host" });
                close();
                return;
              }
              resolve({ kind: "connected", claim });
            }
            if (reply.kind === "error") {
              socket.destroy();
              return;
            }
            if ("host" in reply && reply.host) input.onHost?.(reply.host);
            // A holder keeps its connection until its cooperative execution ends.
            if (reply.kind === "claimed")
              request.signal.removeEventListener("abort", abort);
            if (reply.kind === "done" && acknowledge) acknowledge();
            if (reply.kind === "ownership" || reply.kind === "delivery") {
              socket.destroy();
              return;
            }
            push(reply);
          }
          if (Buffer.byteLength(buffer) > SHARED_WORK_LINE_BYTES)
            socket.destroy();
        });
      });
    },
  };
}

/** A caller-owned store. Publish the immutable reference and reusable-key pointer atomically.
 * `read(reference)` retains that attempt's outcome; `read()` applies the caller's reuse/retry policy. */
export function storedSharedOutcome<A, E>(store: {
  readonly read: (
    publication?: string,
  ) => Promise<PublishedSharedOutcome<A, E> | undefined>;
  readonly publish: (outcome: PublishedSharedOutcome<A, E>) => Promise<void>;
}) {
  return {
    read: store.read,
    run:
      (work: (signal: AbortSignal) => Promise<SharedOutcome<A, E>>) =>
      async (signal: AbortSignal) => {
        const outcome = await work(signal);
        const published = { publication: randomUUID(), outcome };
        await store.publish(published);
        return published;
      },
  };
}

/** The existing query timeout bounds one request, without polling or claiming work.
 * It starts with the connection attempt, not while the attempt waits for a slot.
 * The slot is held until the query finishes, so an ownership or delivery reply the
 * host delays until re-declaration closes (up to 5 seconds) keeps its slot that long.
 * Queries have their own pool, so that delays only other queries, never a claim, and
 * each query is still bounded by its own timer. */
const sharedWorkQuery = async (
  message: SharedWorkMessage,
  directory = budgetDirectory(),
): Promise<SharedWorkReply | undefined> => {
  const path = join(directory, "budget.sock");
  const release = await acquireConnect(path, undefined, queryPool);
  return new Promise((resolve) => {
    let socket: Socket;
    try {
      socket = createConnection(path);
    } catch (cause) {
      release();
      throw cause;
    }
    let buffer = "";
    const finish = (reply?: SharedWorkReply) => {
      clearTimeout(timer);
      socket.destroy();
      release();
      resolve(reply);
    };
    const timer = setTimeout(() => finish(), 10_000);
    socket.on("error", () => finish());
    socket.on("close", () => finish());
    socket.on("connect", () => socket.write(`${JSON.stringify(message)}\n`));
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      if (Buffer.byteLength(buffer) > SHARED_WORK_LINE_BYTES) return finish();
      const index = buffer.indexOf("\n");
      if (index < 0) return;
      try {
        finish(
          readData(SharedWorkReply, JSON.parse(buffer.slice(0, index)), {
            source: join(directory, "budget.sock"),
          }),
        );
      } catch {
        finish();
      }
    });
  });
};
/** Read-only ownership observation, delayed by the host until re-declaration closes. */
export const sharedWorkOwnership = async (
  store: string,
  key: string,
  directory = budgetDirectory(),
): Promise<"live" | "ended" | "unknown"> => {
  const reply = await sharedWorkQuery(
    { version: 1, kind: "ownership", store: digest(store), key: digest(key) },
    directory,
  );
  return reply?.kind === "ownership"
    ? reply.live
      ? "live"
      : "ended"
    : "unknown";
};
/** Identities are already digested, so orphan recovery can query from immutable key names. */
export const sharedWorkDelivery = async (
  input: {
    readonly store: string;
    readonly key: string;
    readonly host?: string;
    readonly publication?: string;
  },
  directory = budgetDirectory(),
) => {
  const reply = await sharedWorkQuery(
    { version: 1, kind: "delivery", ...input },
    directory,
  );
  return reply?.kind === "delivery" ? reply : undefined;
};
