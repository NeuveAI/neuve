import { readData } from "@neuve/records-core";
import { budgetDirectory } from "@neuve/records-core/budget-directory";
export { budgetDirectory } from "@neuve/records-core/budget-directory";
import { SharedWork } from "@neuve/records-core/shared-work";
import { InsideSharedWorkGrant } from "@neuve/records-core/shared-work-effect";
import { sharedWorkSocket } from "@neuve/records-core/shared-work-socket";
import { SharedWorkHost } from "@neuve/records-core/shared-work-host";
import { SharedWorkMessage } from "@neuve/records-core/shared-work-protocol";
import { recordBudget } from "./telemetry.ts";
import {
  acquireGrant,
  admitForJob,
  type BudgetAdmissionFailed,
  type OnBudgetYield,
} from "./acquire.ts";
import { Database } from "bun:sqlite";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { createConnection, createServer, type Socket } from "node:net";
import { availableParallelism, platform } from "node:os";
import { Worker } from "@neuve/records-core";
import { join } from "node:path";
import { z } from "zod";
import { Effect } from "effect";
import {
  BackgroundYield,
  budgetOwner,
  Observation,
  Request,
  Scheduler,
  type Budget,
  type Grant,
  type Numbers,
  type ReviewLease,
} from "./scheduler.ts";

class BudgetUnavailable extends Error {}
/** The host answered and refused the message, as an older host refuses a key it does not know. */
class BudgetRefused extends Error {}

/** How long a release waits for the host's answer; closing the connection releases the grant too. */
export const RELEASE_WAIT_MS = 2_000;

const Reply = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("yield") }),
  z.strictObject({
    kind: z.literal("grant"),
    permits: z.number().int().positive(),
    numbers: z.record(z.string(), z.number()).optional(),
  }),
  z.strictObject({
    kind: z.literal("numbers"),
    numbers: z.record(z.string(), z.number()),
  }),
  z.strictObject({ kind: z.literal("error") }),
]);
const BudgetMessage = z.discriminatedUnion("kind", [
  z.strictObject({
    version: z.literal(1),
    kind: z.literal("active"),
    account: z.string().regex(/^[a-f0-9]{64}$/),
    owner: z.string().min(1).max(128),
  }),
  z.strictObject({
    version: z.literal(1),
    kind: z.literal("measure"),
    account: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  z.strictObject({
    version: z.literal(1),
    kind: z.literal("admit"),
    request: Request,
  }),
  z.strictObject({
    version: z.literal(1),
    kind: z.literal("throttle"),
    retryAfter: z.boolean().default(false),
    throttled: z.boolean().default(true),
    account: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  z.strictObject({ version: z.literal(1), kind: z.literal("capacity") }),
  z.strictObject({ version: z.literal(1), kind: z.literal("observe") }),
  z.strictObject({
    version: z.literal(1),
    kind: z.literal("release"),
    observation: Observation.optional(),
  }),
]);
const Message = z.discriminatedUnion("kind", [
  ...BudgetMessage.options,
  ...SharedWorkMessage.options,
]);
const privateDirectory = (directory: string) => {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directory);
  if (
    !stat.isDirectory() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o077) !== 0
  )
    throw new Error("Budget directory must be private and owned by this user");
};
export async function machineThreads() {
  let logical = availableParallelism(),
    performance = logical,
    efficiency = logical;
  if (platform() === "darwin") {
    const result = Bun.spawnSync([
      "/usr/sbin/sysctl",
      "-n",
      "hw.perflevel0.physicalcpu",
    ]);
    const cores = Number(result.stdout.toString().trim());
    if (result.exitCode === 0 && cores > 0) {
      performance = cores;
      efficiency = Math.max(1, logical - cores);
    }
  } else if (platform() === "linux") {
    try {
      const [quota, period] = (await readFile("/sys/fs/cgroup/cpu.max", "utf8"))
        .trim()
        .split(/\s+/);
      if (quota !== "max" && Number(period) > 0)
        logical = Math.min(
          logical,
          Math.max(1, Math.floor(Number(quota) / Number(period))),
        );
    } catch {
      /* No cgroup v2 quota. */
    }
    performance = logical;
    efficiency = logical;
  }
  const override = process.env.NEUVE_CPU_BUDGET;
  const threads =
    override === undefined
      ? Math.max(1, Math.min(performance, logical - 2))
      : z.coerce.number().int().min(1).max(performance).parse(override);
  return { threads, efficiency };
}
export const fixedConcurrency = () =>
  process.env.NEUVE_MODEL_CONCURRENCY === "adaptive"
    ? undefined
    : z.coerce
        .number()
        .int()
        .min(4)
        .max(32)
        .parse(process.env.NEUVE_MODEL_CONCURRENCY ?? "8");

/** Worker startup only. The SQLite write lock lives as long as the host, so a refused socket
 * never permits takeover from a live host. Kernel lock release makes process-ID probes unnecessary. */
export async function hostBudget(
  input: {
    directory?: string;
    threads?: number;
    efficiency?: number;
    fixed?: number;
    emit?: (numbers: Numbers) => void;
  } = {},
) {
  const directory = input.directory ?? budgetDirectory();
  privateDirectory(directory);
  const sized = await machineThreads();
  const scheduler = new Scheduler(
    input.threads ?? sized.threads,
    input.efficiency ?? sized.efficiency,
    input.fixed ?? fixedConcurrency(),
    input.emit,
  );
  const priorDatabase = existsSync(join(directory, "budget.sqlite"));
  const db = new Database(join(directory, "budget.sqlite"), { create: true });
  chmodSync(join(directory, "budget.sqlite"), 0o600);
  db.exec("PRAGMA busy_timeout=0");
  try {
    db.exec("BEGIN IMMEDIATE");
  } catch {
    db.close();
    return undefined;
  }
  const socketPath = join(directory, "budget.sock");
  // An unlinked lock inode must not let a second host replace a live socket.
  try {
    const live = await new Promise<boolean>((resolve, reject) => {
      const probe = createConnection(socketPath);
      const timer = setTimeout(() => {
        probe.destroy();
        resolve(true);
      }, 1000);
      probe.once("connect", () => {
        clearTimeout(timer);
        probe.destroy();
        resolve(true);
      });
      probe.once("error", (cause) => {
        clearTimeout(timer);
        probe.destroy();
        if (
          "code" in cause &&
          (cause.code === "ENOENT" || cause.code === "ECONNREFUSED")
        )
          resolve(false);
        else reject(cause);
      });
    });
    if (live) {
      db.close();
      return undefined;
    }
  } catch (cause) {
    db.close();
    throw cause;
  }
  // History only, under the elected host's write lock. A contender may have
  // created and hosted the database after our pre-open existence check.
  const history = join(directory, "shared-work-started");
  const replacing = priorDatabase || existsSync(history);
  try {
    writeFileSync(history, "", { flag: "a", mode: 0o600 });
  } catch (cause) {
    db.close();
    throw cause;
  }
  const claims = new SharedWorkHost(replacing);
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    if (sockets.size >= 8192) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    let buffer = "",
      granted: Grant | undefined,
      requested = false;
    const abort = new AbortController();
    socket.on("close", () => {
      claims.disconnected(socket);
      abort.abort();
      granted?.release();
      sockets.delete(socket);
    });
    socket.on("error", () => socket.destroy());
    socket.setTimeout(30_000, () => {
      if (!granted && !claims.has(socket)) socket.destroy();
    });
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      if (Buffer.byteLength(buffer) > 8192) {
        socket.destroy();
        return;
      }
      let index: number;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        void (async () => {
          const message = readData(Message, JSON.parse(line), {
            source: socketPath,
          });
          if (message.kind === "ownership" || message.kind === "delivery") {
            claims.message(socket, message);
            return;
          }
          if (message.kind === "claim") {
            if (requested) throw new Error("One claim or grant per connection");
            requested = true;
            socket.setTimeout(0);
            claims.message(socket, message);
            return;
          }
          if (message.kind === "settle" || message.kind === "withdraw") {
            claims.message(socket, message);
            return;
          }
          if (claims.has(socket))
            throw new Error("Claim connections only accept settle or withdraw");
          if (message.kind === "release") {
            granted?.release(message.observation);
            granted = undefined;
            socket.end(JSON.stringify({ kind: "numbers", numbers: {} }) + "\n");
            return;
          }
          if (message.kind === "active") {
            if (requested) throw new Error("One lease per connection");
            requested = true;
            socket.setTimeout(0);
            const release = await scheduler.activate(
              message.account,
              message.owner,
            );
            if (socket.destroyed) {
              release();
              return;
            }
            granted = { permits: 1, release };
            socket.write(JSON.stringify({ kind: "grant", permits: 1 }) + "\n");
            return;
          }
          if (message.kind === "measure") {
            socket.end(
              JSON.stringify({
                kind: "numbers",
                numbers: await scheduler.measure(message.account),
              }) + "\n",
            );
            return;
          }
          if (message.kind === "throttle") {
            await scheduler.throttle(
              message.account,
              message.retryAfter,
              message.throttled,
            );
            socket.end(JSON.stringify({ kind: "numbers", numbers: {} }) + "\n");
            return;
          }
          if (requested) throw new Error("One grant per connection");
          requested = true;
          socket.setTimeout(0);
          if (message.kind === "admit") {
            const grant = await scheduler.admit(message.request, abort.signal);
            if (socket.destroyed) {
              grant.release();
              return;
            }
            granted = grant;
            socket.write(
              `${JSON.stringify({ kind: "grant", permits: grant.permits, numbers: grant.numbers })}\n`,
            );
          } else
            socket.end(
              `${JSON.stringify({ kind: "numbers", numbers: await (message.kind === "capacity" ? scheduler.capacity() : scheduler.observe()) })}\n`,
            );
        })().catch((cause) =>
          socket.end(
            JSON.stringify({
              kind: cause instanceof BackgroundYield ? "yield" : "error",
            }) + "\n",
          ),
        );
      }
    });
  });
  let serverErrors = 0;
  server.on("error", () => {
    serverErrors++;
    input.emit?.({ serverErrors });
  });
  try {
    rmSync(socketPath, { force: true });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    chmodSync(socketPath, 0o600);
    server.unref();
  } catch (error) {
    db.close();
    throw error;
  }
  let closing: Promise<void> | undefined;
  return {
    scheduler,
    claims,
    close: () =>
      (closing ??= (async () => {
        claims.close();
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        rmSync(socketPath, { force: true });
        db.close();
      })()),
  };
}

/** Connections one process may have waiting in one host's accept queue: macOS's holds 128. */
const UNACCEPTED = 32;
/** A gated connection reports its first reply line, and an end it did not cause. */
interface Ticket {
  readonly replied: () => void;
  readonly ended: () => void;
}
/**
 * Bounds this process's connections to one host that the host has not yet accepted, whatever the
 * host is doing (a Unix socket's `connect` fires when the kernel queues it, before the accept).
 * A listening socket accepts first in, first out, so a reply on any connection proves every
 * connection opened before it was accepted; until then a connection counts as unaccepted, and at
 * `UNACCEPTED` new ones wait, first come first served, while one barrier asks `capacity` (which
 * every host generation answers at once) to confirm those before it. A connection leaves the count
 * only by such a reply or when the host's side ends it; one this process destroys first (an abort,
 * a timeout) may still sit in the accept queue, so it keeps its place until a later reply or a
 * barrier confirms it. A barrier that ends without a reply means the host is gone: the waiters go,
 * into the callers' recovery.
 */
class ConnectGate {
  private sequence = 0;
  /** Unconfirmed connections' sequence numbers; a Set iterates in insertion, so opening, order. */
  private readonly unconfirmed = new Set<number>();
  private readonly waiting: Array<() => void> = [];
  private barrier = false;
  constructor(
    private readonly path: string,
    private readonly idle: () => void,
  ) {}
  /** Runs `start` once there is room; returns a withdrawal for a waiter that has not started. */
  enter(start: (ticket: Ticket) => void) {
    const run = () => start(this.ticket());
    this.waiting.push(run);
    this.pump();
    return () => {
      const index = this.waiting.indexOf(run);
      if (index >= 0) this.waiting.splice(index, 1);
      this.pump();
    };
  }
  private ticket(): Ticket {
    const sequence = this.sequence++;
    this.unconfirmed.add(sequence);
    return {
      replied: () => this.confirm(sequence),
      ended: () => {
        this.unconfirmed.delete(sequence);
        this.pump();
      },
    };
  }
  private confirm(through: number) {
    for (const sequence of this.unconfirmed) {
      if (sequence > through) break;
      this.unconfirmed.delete(sequence);
    }
    this.pump();
  }
  private pump() {
    while (this.waiting.length && this.unconfirmed.size < UNACCEPTED)
      this.waiting.shift()?.();
    if (this.waiting.length && !this.barrier) this.openBarrier();
    if (!this.waiting.length && !this.unconfirmed.size && !this.barrier)
      this.idle();
  }
  private openBarrier() {
    this.barrier = true;
    const through = this.sequence++;
    let replied = false,
      finished = false;
    const socket = createConnection(this.path);
    const done = () => {
      if (finished) return;
      finished = true;
      this.barrier = false;
      socket.destroy();
      if (replied) this.confirm(through);
      else {
        this.unconfirmed.clear();
        this.pump();
      }
    };
    socket.on("connect", () =>
      socket.write(`${JSON.stringify({ version: 1, kind: "capacity" })}\n`),
    );
    socket.on("data", (chunk) => {
      if (!chunk.includes("\n")) return;
      replied = true;
      done();
    });
    socket.on("error", done);
    socket.on("close", done);
  }
}
const gates = new Map<string, ConnectGate>();
const gateFor = (path: string) => {
  let gate = gates.get(path);
  if (!gate) {
    const created = new ConnectGate(path, () => {
      if (gates.get(path) === created) gates.delete(path);
    });
    gates.set(path, (gate = created));
  }
  return gate;
};

/** One connection per grant. Host loss is exposed so heavy children can stop. */
export function localBudget(directory = budgetDirectory()): Budget {
  const path = join(directory, "budget.sock");
  const exchange = (message: z.infer<typeof Message>, signal?: AbortSignal) =>
    new Promise<{ reply: z.infer<typeof Reply>; socket: Socket }>(
      (resolve, reject) => {
        signal?.throwIfAborted();
        let socket: Socket | undefined,
          ours = false,
          buffer = "",
          settled = false;
        const cleanup = () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
        };
        // A connection destroyed here keeps its place at the gate: the host may not have accepted it.
        const abort = () => {
          withdraw();
          ours = true;
          socket?.destroy();
          cleanup();
          reject(new Error("Budget request aborted"));
        };
        const timer = setTimeout(abort, 300_000);
        signal?.addEventListener("abort", abort, { once: true });
        const withdraw = gateFor(path).enter((entered) => {
          const connection = createConnection(path);
          socket = connection;
          connection.on("error", () => {
            if (!ours) entered.ended();
            cleanup();
            reject(new BudgetUnavailable("Machine budget connection failed"));
          });
          connection.on("close", () => {
            if (!ours) entered.ended();
            cleanup();
            if (!settled)
              reject(new BudgetUnavailable("Machine budget connection closed"));
          });
          connection.on("connect", () => {
            clearTimeout(timer);
            connection.write(`${JSON.stringify(message)}\n`);
          });
          connection.on("data", (chunk) => {
            buffer += chunk.toString();
            if (buffer.length > 8192) {
              abort();
              return;
            }
            if (!buffer.includes("\n")) return;
            entered.replied();
            try {
              const reply = readData(
                Reply,
                JSON.parse(buffer.slice(0, buffer.indexOf("\n"))),
                { source: path },
              );
              settled = true;
              connection.removeAllListeners("data");
              cleanup();
              if (reply.kind === "yield") {
                connection.destroy();
                reject(new BackgroundYield());
              } else if (reply.kind === "error") {
                connection.destroy();
                reject(new BudgetRefused("Machine budget refused request"));
              } else resolve({ reply, socket: connection });
            } catch {
              abort();
            }
          });
        });
      },
    );
  const numbers = async (kind: "capacity" | "observe") => {
    const { reply, socket } = await exchange({ version: 1, kind });
    socket.end();
    if (reply.kind !== "numbers") throw new Error("Unexpected budget reply");
    return reply.numbers;
  };
  return {
    async activate(account, owner) {
      const { socket } = await exchange({
        version: 1,
        kind: "active",
        account,
        owner: budgetOwner(owner),
      });
      let released = false;
      const lost = new AbortController();
      socket.once("close", () => {
        if (!released) lost.abort();
      });
      return Object.assign(
        () => {
          if (!released) {
            released = true;
            socket.end(JSON.stringify({ version: 1, kind: "release" }) + "\n");
          }
        },
        { signal: lost.signal },
      );
    },
    async measure(account) {
      const { reply, socket } = await exchange({
        version: 1,
        kind: "measure",
        account,
      });
      socket.end();
      if (reply.kind !== "numbers") throw new Error("Unexpected budget reply");
      return reply.numbers;
    },
    async throttle(account, retryAfter = false, throttled = true) {
      const { socket } = await exchange({
        version: 1,
        kind: "throttle",
        account,
        retryAfter,
        throttled,
      });
      socket.end();
    },
    capacity: () => numbers("capacity"),
    observe: () => numbers("observe"),
    async admit(request, signal) {
      // Shortened before this parse, so a host of any build reads the owner it caps.
      const parsed = Request.parse({
        ...request,
        owner: budgetOwner(request.owner),
      });
      const admit = (body: Request) =>
        exchange({ version: 1, kind: "admit", request: body }, signal);
      // A host older than readings refuses the `reading` key. On a refusal of a reading, ask the
      // host's capacity: one that reports `readings` refused it for real (a full queue), and the
      // refusal stands, since a resent reading would be admitted as a turn. Any other host is asked
      // once more as an older client would. Only a refusal leads here; an abort or a lost
      // connection, in either exchange, propagates as itself.
      const { reply, socket } = await admit(parsed).catch(
        async (cause: unknown) => {
          if (!(cause instanceof BudgetRefused) || !parsed.priority.reading)
            throw cause;
          const knowsReadings = await exchange(
            { version: 1, kind: "capacity" },
            signal,
          ).then(
            ({ reply, socket }) => {
              socket.end();
              return reply.kind === "numbers" && reply.numbers.readings === 1;
            },
            (failure: unknown) => {
              if (failure instanceof BudgetRefused) return false;
              throw failure;
            },
          );
          if (knowsReadings) throw cause;
          const { reading: _reading, ...priority } = parsed.priority;
          return admit({ ...parsed, priority });
        },
      );
      if (reply.kind !== "grant") {
        socket.destroy();
        throw new Error("Unexpected budget reply");
      }
      let released = false;
      const lost = new AbortController();
      socket.on("close", () => {
        if (!released) lost.abort(new Error("Machine budget host lost"));
      });
      const descriptor = z
        .object({ _handle: z.object({ fd: z.number().int().nonnegative() }) })
        .parse(socket)._handle.fd;
      return {
        ...(request.resource.kind === "cpu" ? { signal: lost.signal } : {}),
        descriptor,
        permits: reply.permits,
        ...(reply.numbers ? { numbers: reply.numbers } : {}),
        async release(observation) {
          if (released) return;
          released = true;
          const ack = new Promise<void>((resolve) => {
            if (socket.destroyed) resolve();
            else {
              socket.once("data", () => resolve());
              socket.once("close", () => resolve());
            }
          });
          socket.end(
            `${JSON.stringify({ version: 1, kind: "release", ...(observation === undefined ? {} : { observation: Observation.parse(observation) }) })}\n`,
          );
          const unanswered = setTimeout(
            () => socket.destroy(),
            RELEASE_WAIT_MS,
          );
          await ack;
          clearTimeout(unanswered);
        },
      };
    },
  };
}

export async function withCpuGrant<A>(
  budget: Budget,
  request: Omit<Request, "resource"> & { permits: number },
  work: (permits: number, signal: AbortSignal) => Promise<A>,
  signal?: AbortSignal,
  onYield?: OnBudgetYield,
): Promise<A> {
  const grant = await admitForJob(
    budget,
    {
      owner: request.owner,
      priority: request.priority,
      resource: { kind: "cpu", permits: request.permits },
    },
    signal ?? new AbortController().signal,
    onYield,
  );
  try {
    return await work(grant.permits, signal ?? new AbortController().signal);
  } finally {
    await grant.release();
  }
}

type WorkerHost = Awaited<ReturnType<typeof hostBudget>>;
const managers = new Map<string, { host: WorkerHost }>();
const elections = new SharedWork<void>();
const floor = new Scheduler(1, 1, 4, undefined, Date.now, true);
const floorMeasure = floor.measure.bind(floor);
floor.measure = async (account) => ({
  ...(await floorMeasure(account)),
  floor: 1,
});
function recoveringBudget(
  directory: string,
  worker: boolean,
): Budget & { recoverSharedWork: () => Promise<void> } {
  const local = localBudget(directory);
  const state = managers.get(directory) ?? {
    host: undefined,
  };
  if (worker) managers.set(directory, state);
  const elect = async () => {
    await elections.run({
      scope: directory,
      key: "elect",
      keepRunning: true,
      run: async () => {
        const candidate = await hostBudget({ directory });
        if (candidate) state.host = candidate;
        return { kind: "succeeded", value: undefined };
      },
    });
  };
  const leases = new Map<
    symbol,
    { account: string; owner: string; release: ReviewLease }
  >();
  let needsReplay = false;
  const reconnects = new SharedWork<void>();
  let retryAfter = 0,
    retryDelay = 0;
  const recover = async () => {
    await reconnects.run({
      scope: directory,
      key: "recover",
      keepRunning: true,
      run: async () => {
        if (worker) await elect();
        else await local.capacity();
        for (const [key, lease] of leases) {
          const next = await local.activate?.(lease.account, lease.owner);
          if (next) {
            lease.release();
            if (leases.has(key)) lease.release = next;
            else next();
          }
        }
        needsReplay = false;
        return { kind: "succeeded", value: undefined };
      },
    });
  };
  const execute = async <A>(
    operation: (budget: Budget) => Promise<A>,
    admission = false,
  ): Promise<A> => {
    // Active review leases retain their existing recovery path. Idle clients
    // retry on demand after 100 ms, doubling up to one second while unreachable.
    if (admission && leases.size === 0 && performance.now() < retryAfter)
      return operation(floor);
    const connected = (value: A) => {
      retryAfter = retryDelay = 0;
      return value;
    };
    try {
      if (
        needsReplay ||
        [...leases.values()].some((l) => l.release.signal?.aborted)
      )
        await recover();
      return connected(await operation(local));
    } catch (cause) {
      if (!(cause instanceof BudgetUnavailable)) throw cause;
      for (let retry = 0; retry < 4; retry++) {
        try {
          await recover();
          return connected(await operation(local));
        } catch (retryCause) {
          if (!(retryCause instanceof BudgetUnavailable)) {
            if (!(retryCause instanceof Error && "code" in retryCause))
              throw retryCause;
            break;
          }
          if (retry < 3)
            await new Promise<void>((resolve) => setTimeout(resolve, 10));
        }
      }
      needsReplay = true;
      if (admission) {
        retryDelay = Math.min(retryDelay ? retryDelay * 2 : 100, 1000);
        retryAfter = performance.now() + retryDelay;
      }
      return operation(floor);
    }
  };
  return {
    recoverSharedWork: recover,
    admit: (request, signal) =>
      execute(async (b) => {
        const grant = await b.admit(request, signal);
        return b === floor
          ? {
              ...grant,
              floor: true,
              numbers: { ...grant.numbers, floor: 1, limit: 4 },
            }
          : grant;
      }, true),
    async activate(account, owner) {
      const release = await execute(
        async (b) => (await b.activate?.(account, owner)) ?? (() => {}),
      );
      const key = Symbol(owner),
        lease = { account, owner, release };
      leases.set(key, lease);
      return () => {
        if (leases.delete(key)) lease.release();
      };
    },
    measure: (account) =>
      execute(async (b) => (await b.measure?.(account)) ?? {}),
    capacity: () => execute((b) => b.capacity()),
    observe: () => execute((b) => b.observe()),
    throttle: (...args) => execute((b) => b.throttle(...args)),
  };
}
/** Workers retry election after a lost connection; model requests already streaming keep running. */
export async function workerBudget(
  directory = budgetDirectory(),
): Promise<Budget & { recoverSharedWork: () => Promise<void> }> {
  const budget = recoveringBudget(directory, true);
  await budget.capacity();
  return budget;
}

/** Only the long-lived worker loop may elect; all other callers remain clients. */
export const jobBudget = Effect.flatMap(Worker.Running, (running) =>
  Effect.promise(() => (running ? workerBudget() : clientBudget())),
);
export async function closeWorkerBudget(
  directory = budgetDirectory(),
): Promise<boolean> {
  const state = managers.get(directory);
  if (!state?.host) {
    managers.delete(directory);
    return true;
  }
  const held = await state.host.scheduler.observe();
  if (
    (held.held ?? 0) +
      (held.providerHeld ?? 0) +
      (held.waiting ?? 0) +
      (held.activeRuns ?? 0) +
      state.host.claims.size >
    0
  )
    return false;
  await state.host.close();
  managers.delete(directory);
  return true;
}

/** Use after computation-key and in-process locks, at a CPU pool's work boundary. */
export function withCpuEffect<A, E, R>(
  budget: Budget,
  request: Omit<Request, "resource"> & { permits: number },
  work: (permits: number, signal: AbortSignal) => Effect.Effect<A, E, R>,
  onYield?: OnBudgetYield,
): Effect.Effect<A, E | BudgetAdmissionFailed, R> {
  return Effect.acquireUseRelease(
    Effect.interruptible(
      acquireGrant(
        budget,
        {
          owner: request.owner,
          priority: request.priority,
          resource: { kind: "cpu", permits: request.permits },
        },
        onYield,
      ),
    ),
    (grant) =>
      Effect.andThen(
        recordBudget({ floor: grant.floor ? 1 : 0 }),
        work(grant.permits, new AbortController().signal).pipe(
          Effect.provideService(InsideSharedWorkGrant, true),
        ),
      ),
    (grant) =>
      Effect.promise(async () => {
        await grant.release();
      }),
  );
}

/**
 * Apply these caps at the heavy child's spawn; pass descriptor at stdio index 3. A background child
 * lowers its CPU priority only, on every platform: no background class, so the OS schedules it on
 * any core and never holds back its disk access.
 */
export function cpuChildSettings(grant: Grant, priority: Request["priority"]) {
  return {
    descriptor: grant.descriptor,
    prefix:
      priority.class === "interactive" ? [] : ["/usr/bin/nice", "-n", "19"],
    env: {
      GOMAXPROCS: String(grant.permits),
      ENTIRE_GRAPH_GREP_CPU: String(grant.permits),
      ENTIRE_GRAPH_GREP_THREADS: "1",
      NEUVE_CPU_GRANT_PERMITS: grant.floor ? undefined : String(grant.permits),
      NEUVE_BUDGET_FLOOR: grant.floor ? "1" : "0",
    },
  };
}

/** Clients retry joining on demand; failed admissions briefly remember the transient floor. */
export async function clientBudget(
  directory = budgetDirectory(),
): Promise<Budget & { recoverSharedWork: () => Promise<void> }> {
  return recoveringBudget(directory, false);
}

/** Claims reuse the worker/client recovery policy; this factory never elects on its own. */
export const budgetSharedWork = (
  budget: { recoverSharedWork: () => Promise<void> },
  directory = budgetDirectory(),
) => sharedWorkSocket({ directory, recover: budget.recoverSharedWork });
