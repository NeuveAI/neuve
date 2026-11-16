import { resolve } from "node:path";

/**
 * A bound on the connections this process has to one Unix socket that the host
 * has not yet answered, per pool. A slot is taken before `createConnection` and
 * released when the host's first reply arrives, or when the attempt ends without
 * one (close, error, abort, or the caller's own timer). An answered connection no
 * longer counts, however long it stays open.
 *
 * The `connect` event is not the end of an attempt: on a Unix socket it fires
 * once the kernel queues the connection, before the host accepts it. Releasing
 * there would only pace attempts, and a paused host would let them pile up in
 * its accept queue.
 *
 * Pools keep kinds of work that the host answers on different terms from
 * waiting on each other: a reply the host delays holds slots only in its own
 * pool. Each pool's user gives its size, and the size is fixed by the pool's
 * first use. A pool's name means one size everywhere in the process: the same
 * name with another size is refused, on any socket. Only names are remembered,
 * never socket paths, so nothing grows with the number of sockets used. Every
 * pool on one socket, in every process, shares that socket's accept queue, so
 * the sizes must add up to less than it.
 *
 * The bound holds for host pauses shorter than the callers' own timers (the
 * shared-work claim's is 2 seconds). Past that, a caller abandons its
 * connection, but the kernel keeps it in the accept queue until the host
 * accepts it, so a hung host's queue fills by one pool's worth per timer
 * period, and once it is full later attempts are refused at once. Measured on
 * this Mac on 12 November 2026, with a host hung for a minute and 300 claims
 * through a pool of 32: 32 unreachable floors each at 2, 4 and 6 seconds and
 * the last 204 at 8 seconds, against 172 at once and 128 at 2 seconds without
 * the gate. That is the accepted cost: with a hung host, callers learn it is
 * unreachable later than before (at most about 128 ÷ pool size timer periods),
 * in exchange for no false "unreachable" while the host is alive.
 *
 * It is not a lock and not a claim. It decides nothing about who runs shared
 * work; the budget host's claims stay the only claim (record 0016). It only
 * keeps a burst of connections inside the listening socket's accept queue, so
 * a reachable host is not mistaken for an unreachable one.
 *
 * The key is the socket file's own path, normalised with `node:path`
 * `resolve` and never its directory, together with the pool's name, so every
 * client of one socket and pool in this process shares one key. No filesystem
 * call is made for it.
 *
 * First come, first served within a pool. There is no timer and no polling: a
 * release hands its slot straight to the next waiter.
 */

/** The size of the default pool, for callers that name none. macOS queues 128
 * pending connections per socket (`kern.ipc.somaxconn`). Measured on this Mac:
 * of 1,000 attempts opened in one tick, 128 connected and 872 failed; with at
 * most 32 outstanding at a time, 3,000 of 3,000 connected in about 240 ms. With
 * the host's event loop blocked for 40 ms as 500 claims began, releasing on
 * `connect` gave 372 unreachable floors; releasing on the host's first reply
 * gave none. */
export const CONNECT_ATTEMPTS_PER_SOCKET = 32;

/** A named pool of connect slots on one socket. */
export interface ConnectPool {
  readonly name: string;
  readonly size: number;
}

/** The pool of callers that name none. */
export const DEFAULT_CONNECT_POOL: ConnectPool = {
  name: "default",
  size: CONNECT_ATTEMPTS_PER_SOCKET,
};

type Waiter = { readonly grant: () => void };
type Gate = { held: number; readonly waiting: Set<Waiter> };
// Keyed by socket path and pool name, and deleted when idle.
const gates = new Map<string, Gate>();
// Keyed by pool name alone and kept after a pool goes idle, so a later use cannot
// quietly resize it and the map cannot grow with socket paths.
const sizes = new Map<string, number>();
const keyOf = (path: string, pool: string) =>
  JSON.stringify([resolve(path), pool]);

const releaser = (key: string, gate: Gate) => {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    // A Set iterates in insertion order, which keeps the queue first come, first served.
    for (const next of gate.waiting) {
      gate.waiting.delete(next);
      next.grant();
      return;
    }
    gate.held--;
    if (gate.held === 0) gates.delete(key);
  };
};

/** Resolves with this attempt's release once a slot in `pool` is free. Release
 * when the attempt ends; only the first call frees the slot. An aborted signal
 * leaves the queue and rejects with its reason, taking no slot. Throws at once
 * when `pool` names a pool already used in this process with another size, on
 * any socket, or when its size is not a positive integer: both are programming
 * errors. */
export function acquireConnect(
  path: string,
  signal?: AbortSignal,
  pool: ConnectPool = DEFAULT_CONNECT_POOL,
): Promise<() => void> {
  if (!Number.isSafeInteger(pool.size) || pool.size < 1)
    throw new RangeError(
      `Connect pool "${pool.name}" needs a positive integer size, not ${pool.size}`,
    );
  const fixed = sizes.get(pool.name);
  if (fixed === undefined) sizes.set(pool.name, pool.size);
  else if (fixed !== pool.size)
    throw new Error(
      `Connect pool "${pool.name}" has ${fixed} slots; it cannot also be used with ${pool.size}`,
    );
  const key = keyOf(path, pool.name);
  if (signal?.aborted) return Promise.reject(signal.reason);
  let gate = gates.get(key);
  if (!gate) {
    gate = { held: 0, waiting: new Set() };
    gates.set(key, gate);
  }
  const current = gate;
  if (current.held < pool.size && !current.waiting.size) {
    current.held++;
    return Promise.resolve(releaser(key, current));
  }
  return new Promise((grant, reject) => {
    const abort = () => {
      current.waiting.delete(waiter);
      reject(signal?.reason);
    };
    // The released slot passes to this waiter, so `held` does not change.
    const waiter: Waiter = {
      grant: () => {
        signal?.removeEventListener("abort", abort);
        grant(releaser(key, current));
      },
    };
    signal?.addEventListener("abort", abort, { once: true });
    current.waiting.add(waiter);
  });
}

/** The attempts held and waiting for one socket path and pool, for telemetry and tests. */
export function connectSlots(
  path: string,
  pool: string = DEFAULT_CONNECT_POOL.name,
): {
  readonly held: number;
  readonly waiting: number;
} {
  const gate = gates.get(keyOf(path, pool));
  return { held: gate?.held ?? 0, waiting: gate?.waiting.size ?? 0 };
}

/** How much state the gate keeps in this process, for telemetry and tests: live
 * gates (one per socket path and pool in use) and remembered pool sizes. */
export function connectGateState(): {
  readonly gates: number;
  readonly poolSizes: number;
} {
  return { gates: gates.size, poolSizes: sizes.size };
}
