import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createConnection, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SharedWorkHost } from "../src/shared-work-host.ts";
import {
  SharedWorkMessage,
  SharedWorkReply,
} from "../src/shared-work-protocol.ts";
import {
  SHARED_WORK_CLAIM_POOL,
  SHARED_WORK_CLAIM_SLOTS,
  SHARED_WORK_QUERY_POOL,
  SHARED_WORK_QUERY_SLOTS,
  sharedWorkOwnership,
  sharedWorkSocket,
} from "../src/shared-work-socket.ts";
import {
  CONNECT_ATTEMPTS_PER_SOCKET,
  DEFAULT_CONNECT_POOL,
  acquireConnect,
  connectGateState,
  connectSlots,
} from "../src/socket-connect-gate.ts";

const claimSlots = (path: string) => connectSlots(path, SHARED_WORK_CLAIM_POOL);
const querySlots = (path: string) => connectSlots(path, SHARED_WORK_QUERY_POOL);
const claimPool = {
  name: SHARED_WORK_CLAIM_POOL,
  size: SHARED_WORK_CLAIM_SLOTS,
};

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

// Unix socket paths are limited to about 104 bytes on macOS, so the scratch name stays short.
const scratch = () => {
  const directory = mkdtempSync(join(tmpdir(), "g-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
};

/** A real budget socket in this process, answered by the shared host. It counts the
 * connections it has accepted and not yet answered. While paused it holds every
 * message unanswered until `resume`, and reports how many of each kind it holds. */
const liveHost = async (
  options: { readonly paused?: boolean; readonly redeclaring?: boolean } = {},
) => {
  const directory = scratch();
  const path = join(directory, "budget.sock");
  const claims = new SharedWorkHost(options.redeclaring ?? false);
  const sockets = new Set<Socket>();
  const deferred: Array<{ kind: string; deliver: () => void }> = [];
  const arrivals: Array<{ count: number; resolve: () => void }> = [];
  const notify = () => {
    for (const arrival of [...arrivals])
      if (deferred.length >= arrival.count) {
        arrivals.splice(arrivals.indexOf(arrival), 1);
        arrival.resolve();
      }
  };
  let paused = options.paused ?? false,
    unanswered = 0,
    peak = 0;
  const server = createServer((socket) => {
    sockets.add(socket);
    peak = Math.max(peak, ++unanswered);
    let answered = false;
    const answer = () => {
      if (answered) return;
      answered = true;
      unanswered--;
    };
    const connection = {
      get destroyed() {
        return socket.destroyed;
      },
      write: (line: string) => {
        answer();
        return socket.write(line);
      },
      end: (line: string) => {
        answer();
        return socket.end(line);
      },
    };
    let buffer = "";
    socket.on("error", () => socket.destroy());
    socket.on("close", () => {
      answer();
      claims.disconnected(connection);
      sockets.delete(socket);
    });
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      let index: number;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        let message: SharedWorkMessage;
        try {
          message = SharedWorkMessage.parse(JSON.parse(line));
        } catch {
          socket.destroy();
          return;
        }
        const deliver = () => {
          if (socket.destroyed) return;
          try {
            claims.message(connection, message);
          } catch {
            socket.destroy();
          }
        };
        if (paused) {
          deferred.push({ kind: message.kind, deliver });
          notify();
        } else deliver();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  let stopped: Promise<void> | undefined;
  const stop = () =>
    (stopped ??= new Promise<void>((resolve) => {
      server.close(() => resolve());
      for (const socket of sockets) socket.destroy();
    }));
  cleanups.push(async () => {
    await stop();
    claims.close();
  });
  return {
    directory,
    path,
    peak: () => peak,
    /** Connections accepted and unanswered, and the held messages by kind. */
    unanswered: (): Record<string, number> => {
      const held: Record<string, number> = { connections: unanswered };
      for (const { kind } of deferred) held[kind] = (held[kind] ?? 0) + 1;
      return held;
    },
    /** Resolves once this many messages wait unanswered. */
    arrived: (count: number) =>
      new Promise<void>((resolve) => {
        arrivals.push({ count, resolve });
        notify();
      }),
    resume: () => {
      paused = false;
      for (const { deliver } of deferred.splice(0)) deliver();
    },
    /** Stops listening and drops every connection, as a host that goes away would. */
    stop,
  };
};

/** The same host in a child process, so its event loop can be blocked while this one runs. */
const childHost = async () => {
  const directory = scratch();
  const path = join(directory, "budget.sock");
  const source = `
import { createServer } from "node:net";
import { writeSync } from "node:fs";
import { SharedWorkHost } from ${JSON.stringify(join(import.meta.dir, "../src/shared-work-host.ts"))};
import { SharedWorkMessage } from ${JSON.stringify(join(import.meta.dir, "../src/shared-work-protocol.ts"))};
const claims = new SharedWorkHost(false);
let accepted = 0, unanswered = 0, peak = 0;
const say = (line) => writeSync(1, line + "\\n");
const server = createServer((socket) => {
  accepted++;
  peak = Math.max(peak, ++unanswered);
  let answered = false;
  const answer = () => {
    if (answered) return;
    answered = true;
    unanswered--;
  };
  const connection = {
    get destroyed() { return socket.destroyed; },
    write: (line) => { answer(); return socket.write(line); },
    end: (line) => { answer(); return socket.end(line); },
  };
  let buffer = "";
  socket.on("error", () => socket.destroy());
  socket.on("close", () => { answer(); claims.disconnected(connection); });
  socket.on("data", (chunk) => {
    buffer += chunk.toString();
    let index;
    while ((index = buffer.indexOf("\\n")) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      try { claims.message(connection, SharedWorkMessage.parse(JSON.parse(line))); }
      catch { socket.destroy(); }
    }
  });
});
server.listen(${JSON.stringify(path)}, () => say("listening"));
let input = "";
process.stdin.on("data", (chunk) => {
  input += chunk.toString();
  let index;
  while ((index = input.indexOf("\\n")) >= 0) {
    const command = input.slice(0, index);
    input = input.slice(index + 1);
    if (command.startsWith("stall ")) {
      // Said synchronously, so the parent hears it before the loop blocks.
      say("blocking");
      Bun.sleepSync(Number(command.slice(6)));
    } else if (command === "report") say(JSON.stringify({ accepted, peak }));
    else if (command === "exit") { server.close(); process.exit(0); }
  }
});
`;
  const child = Bun.spawn([process.execPath, "-e", source], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
  });
  cleanups.push(async () => {
    child.kill();
    await child.exited;
  });
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const line = async () => {
    for (;;) {
      const index = buffer.indexOf("\n");
      if (index >= 0) {
        const next = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        return next;
      }
      const { value, done } = await reader.read();
      if (done) throw new Error("The child host ended");
      buffer += decoder.decode(value, { stream: true });
    }
  };
  const send = (command: string) => {
    child.stdin.write(`${command}\n`);
    child.stdin.flush();
  };
  expect(await line()).toBe("listening");
  return { directory, path, line, send };
};

const request = (key: string, signal = new AbortController().signal) => ({
  store: "store",
  key,
  insideGrant: false,
  redeclare: false,
  signal,
});

const closeAll = (
  results: ReadonlyArray<
    Awaited<ReturnType<ReturnType<typeof sharedWorkSocket>["claim"]>>
  >,
) => {
  for (const result of results)
    if (result.kind === "connected") result.claim.close();
};

// Reason: the defect. Past 128 attempts in one tick the macOS accept queue overflows, and an
// overflowed claim would be the unreachable floor and run the same work twice. Without the gate
// this fails on macOS (128 of 500 connect); it would pass on a platform with a larger accept queue.
test("500 claims begun in one tick against a live host all connect", async () => {
  const host = await liveHost();
  const transport = sharedWorkSocket({ directory: host.directory });
  const started = performance.now();
  const results = await Promise.all(
    Array.from({ length: 500 }, (_, index) =>
      transport.claim(request(`key-${index}`)),
    ),
  );
  const elapsedMs = Math.round(performance.now() - started);
  const floors = results.filter((result) => result.kind === "floor").length;
  closeAll(results);
  console.info(
    JSON.stringify({
      case: "500-in-one-tick",
      floors,
      elapsedMs,
      peak: host.peak(),
    }),
  );
  expect(floors).toBe(0);
  expect(host.peak()).toBeLessThanOrEqual(SHARED_WORK_CLAIM_SLOTS);
  expect(claimSlots(host.path)).toEqual({ held: 0, waiting: 0 });
});

// Reason: a host pause must not turn into duplicated work. On a Unix socket `connect` fires
// once the kernel queues a connection, so releasing there let a paused host's accept queue
// overflow (372 floors of 500 at a 40 ms pause); a slot now lasts until the host answers.
test("500 claims begun while the host's event loop is blocked for 40 ms all connect", async () => {
  const host = await childHost();
  const transport = sharedWorkSocket({ directory: host.directory });
  host.send("stall 40");
  // The burst starts only once the child says its loop is about to block.
  expect(await host.line()).toBe("blocking");
  const started = performance.now();
  const results = await Promise.all(
    Array.from({ length: 500 }, (_, index) =>
      transport.claim(request(`key-${index}`)),
    ),
  );
  const elapsedMs = Math.round(performance.now() - started);
  const floors = results.filter((result) => result.kind === "floor").length;
  host.send("report");
  const report = JSON.parse(await host.line()) as {
    accepted: number;
    peak: number;
  };
  closeAll(results);
  console.info(
    JSON.stringify({ case: "stalled-host", floors, elapsedMs, ...report }),
  );
  expect(floors).toBe(0);
  expect(report.accepted).toBe(500);
  expect(report.peak).toBeLessThanOrEqual(SHARED_WORK_CLAIM_SLOTS);
  expect(claimSlots(host.path)).toEqual({ held: 0, waiting: 0 });
});

// Reason: the bound and the leak. Each pool's own bound, counted on the host side: with the host
// holding every message, 300 claims and 100 queries leave exactly 16 claims and 8 queries
// unanswered and open no further connection, which one pool shared by both could not give. Every
// slot is free once the run ends, however long the open claims are held.
test("each pool's bound holds on the host side and every slot is free at the end", async () => {
  const host = await liveHost({ paused: true });
  const transport = sharedWorkSocket({ directory: host.directory });
  const claims = Array.from({ length: 300 }, (_, index) =>
    transport.claim(request(`key-${index}`)),
  );
  const queries = Array.from({ length: 100 }, (_, index) =>
    sharedWorkOwnership("store", `query-${index}`, host.directory),
  );
  await host.arrived(SHARED_WORK_CLAIM_SLOTS + SHARED_WORK_QUERY_SLOTS);
  // Time for any connection past the bound to reach the host.
  await new Promise((resolve) => setTimeout(resolve, 50));
  const unanswered = host.unanswered();
  host.resume();
  const results = await Promise.all(claims);
  const answers = await Promise.all(queries);
  console.info(JSON.stringify({ case: "bound", unanswered }));
  expect(unanswered).toEqual({
    connections: SHARED_WORK_CLAIM_SLOTS + SHARED_WORK_QUERY_SLOTS,
    claim: SHARED_WORK_CLAIM_SLOTS,
    ownership: SHARED_WORK_QUERY_SLOTS,
  });
  expect([SHARED_WORK_CLAIM_SLOTS, SHARED_WORK_QUERY_SLOTS]).toEqual([16, 8]);
  expect(results.every((result) => result.kind === "connected")).toBe(true);
  expect(answers.every((answer) => answer === "ended")).toBe(true);
  // Open claims no longer count against the gate.
  expect(claimSlots(host.path)).toEqual({ held: 0, waiting: 0 });
  expect(querySlots(host.path)).toEqual({ held: 0, waiting: 0 });
  closeAll(results);
  expect(claimSlots(host.path)).toEqual({ held: 0, waiting: 0 });
});

const digest = (text: string) =>
  createHash("sha256").update(text).digest("hex");

/** A claim from a client outside this process's gate, as another process would send it. */
const outsideClaim = (path: string, key: string) =>
  new Promise<{ reply: SharedWorkReply; socket: Socket }>((resolve, reject) => {
    const socket = createConnection(path);
    cleanups.push(() => void socket.destroy());
    let buffer = "";
    socket.on("error", reject);
    socket.on("connect", () =>
      socket.write(
        `${JSON.stringify({
          version: 1,
          kind: "claim",
          store: digest("store"),
          key: digest(key),
          insideGrant: false,
          redeclare: false,
        })}\n`,
      ),
    );
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      const index = buffer.indexOf("\n");
      if (index >= 0)
        resolve({
          reply: SharedWorkReply.parse(JSON.parse(buffer.slice(0, index))),
          socket,
        });
    });
  });

// Reason: a holder that cannot re-declare in time loses its key to a second runner. The host holds
// ownership and delivery replies until its re-declaration window closes, so if queries shared the
// claims' slots, held queries would keep the re-declaring holder off the socket for the whole
// window. The holder's answer races a 1-second bound, so a shared pool fails by naming that.
test("queries held through re-declaration never keep a re-declaring claim from the host", async () => {
  const host = await liveHost({ redeclaring: true });
  const transport = sharedWorkSocket({ directory: host.directory });
  const queries = Array.from({ length: 40 }, (_, index) =>
    sharedWorkOwnership("store", `query-${index}`, host.directory),
  );
  const pools = {
    queries: querySlots(host.path),
    claims: claimSlots(host.path),
  };
  const started = performance.now();
  const holding = transport
    .claim({ ...request("K"), redeclare: true })
    .then(async (holder) => {
      if (holder.kind !== "connected") throw new Error(holder.reason);
      const first = await holder.claim.next();
      return {
        claim: holder.claim,
        first,
        answeredMs: Math.round(performance.now() - started),
      };
    });
  // Settled by the cleanup when the holder loses the race below.
  holding.catch(() => {});
  // A second runner asks for the same key 100 ms later, from outside this process's gate.
  await new Promise((resolve) => setTimeout(resolve, 100));
  const second = await outsideClaim(host.path, "K");
  let bound: ReturnType<typeof setTimeout> | undefined;
  const verdict = await Promise.race([
    holding.then(() => "the host answered the re-declaring holder within 1 s"),
    new Promise<string>((resolve) => {
      bound = setTimeout(
        () => resolve("the re-declaring holder was still unanswered after 1 s"),
        Math.max(0, started + 1000 - performance.now()),
      );
    }),
  ]);
  clearTimeout(bound);
  expect(verdict).toBe("the host answered the re-declaring holder within 1 s");
  const { claim: holder, first, answeredMs } = await holding;
  console.info(
    JSON.stringify({
      case: "re-declaration",
      answeredMs,
      first: first.kind,
      second: second.reply.kind,
    }),
  );
  expect(first).toMatchObject({ kind: "claimed", declaring: true });
  expect(second.reply.kind).toBe("waiting");
  // The two pools do not share slots: 8 held queries left the claim free to start.
  expect(pools).toEqual({
    queries: {
      held: SHARED_WORK_QUERY_SLOTS,
      waiting: 40 - SHARED_WORK_QUERY_SLOTS,
    },
    claims: { held: 0, waiting: 0 },
  });
  // The queries are still held inside the window.
  expect(querySlots(host.path)).toEqual({
    held: SHARED_WORK_QUERY_SLOTS,
    waiting: 40 - SHARED_WORK_QUERY_SLOTS,
  });
  holder.close();
  second.socket.destroy();
  await host.stop();
  expect(
    (await Promise.all(queries)).every((answer) => answer === "unknown"),
  ).toBe(true);
  expect(querySlots(host.path)).toEqual({ held: 0, waiting: 0 });
  expect(claimSlots(host.path)).toEqual({ held: 0, waiting: 0 });
});

// Reason: a stuck slot would stall every later claim. Also states the key rule: the key is the
// socket file's path normalised with `resolve`, plus the pool, so two spellings of one socket
// share one gate, and another pool or another socket file has its own.
test("an aborted waiter leaves the queue and does not delay the next one", async () => {
  const path = join(scratch(), "budget.sock");
  const sameSocket = join(path, "..", ".", "budget.sock");
  const held = await Promise.all(
    Array.from({ length: CONNECT_ATTEMPTS_PER_SOCKET }, () =>
      acquireConnect(path),
    ),
  );
  expect(connectSlots(sameSocket)).toEqual({ held: 32, waiting: 0 });
  // Another pool on the same socket has its own slots, so a full pool never holds it up.
  const other = { name: "other", size: 2 };
  const otherPool = await acquireConnect(path, undefined, other);
  expect(connectSlots(path, "other")).toEqual({ held: 1, waiting: 0 });
  otherPool();
  expect(connectSlots(path, "other")).toEqual({ held: 0, waiting: 0 });
  // A pool's size is fixed by its first use, even once it is idle; another size fails loudly.
  expect(() =>
    acquireConnect(path, undefined, { name: "other", size: 3 }),
  ).toThrow('Connect pool "other"');
  // A name means one size in the whole process, so another socket cannot resize it either.
  expect(() =>
    acquireConnect(join(path, "..", "other.sock"), undefined, {
      name: "other",
      size: 3,
    }),
  ).toThrow('Connect pool "other"');
  expect(() =>
    acquireConnect(path, undefined, { name: "zero", size: 0 }),
  ).toThrow("positive integer size");
  expect(() =>
    acquireConnect(sameSocket, undefined, {
      ...DEFAULT_CONNECT_POOL,
      size: 16,
    }),
  ).toThrow('Connect pool "default"');
  expect(connectSlots(path)).toEqual({ held: 32, waiting: 0 });
  expect(connectSlots(join(path, "..", "other.sock"))).toEqual({
    held: 0,
    waiting: 0,
  });

  const already = new AbortController();
  already.abort(new Error("already"));
  await expect(acquireConnect(path, already.signal)).rejects.toThrow("already");
  expect(connectSlots(path)).toEqual({ held: 32, waiting: 0 });

  const leaving = new AbortController();
  const order: string[] = [];
  const first = acquireConnect(path, leaving.signal);
  const second = acquireConnect(sameSocket).then((release) => {
    order.push("second");
    return release;
  });
  expect(connectSlots(path)).toEqual({ held: 32, waiting: 2 });
  leaving.abort(new Error("left the queue"));
  await expect(first).rejects.toThrow("left the queue");
  expect(connectSlots(path)).toEqual({ held: 32, waiting: 1 });

  // One release hands its slot straight to the next live waiter.
  held[0]!();
  const releaseSecond = await second;
  expect(order).toEqual(["second"]);
  expect(connectSlots(path)).toEqual({ held: 32, waiting: 0 });

  // Only the first call of a release frees the slot.
  held[0]!();
  releaseSecond();
  releaseSecond();
  expect(connectSlots(path)).toEqual({ held: 31, waiting: 0 });
  for (const release of held.slice(1)) release();
  expect(connectSlots(path)).toEqual({ held: 0, waiting: 0 });
});

// Reason: a long-lived process connects to many socket paths over its life; the gate must not
// keep state per path once a path is idle, or its memory grows with every path it has seen.
test("many distinct socket paths leave no per-path state behind", async () => {
  const before = connectGateState();
  const directory = scratch();
  const pool = { name: "many-paths", size: 1 };
  for (let index = 0; index < 10_000; index++) {
    const release = await acquireConnect(
      join(directory, `${index}.sock`),
      undefined,
      pool,
    );
    release();
  }
  expect(connectGateState()).toEqual({
    gates: before.gates,
    poolSizes: before.poolSizes + 1,
  });
});

// Reason: a stuck slot would stall every later claim. A claim keeps honouring its signal while it
// queues, after the slot is handed to it, and while the host has not yet answered it; and its
// slot is held exactly until the host's first reply.
test("claims aborted while queued, on handoff and while unanswered free their slots", async () => {
  const host = await liveHost({ paused: true });
  const transport = sharedWorkSocket({ directory: host.directory });
  const held = await Promise.all(
    Array.from({ length: SHARED_WORK_CLAIM_SLOTS }, () =>
      acquireConnect(host.path, undefined, claimPool),
    ),
  );

  const queued = new AbortController();
  const waiting = transport.claim(request("queued", queued.signal));
  expect(claimSlots(host.path)).toEqual({ held: 16, waiting: 1 });
  queued.abort(new Error("aborted while queued"));
  await expect(waiting).rejects.toThrow("aborted while queued");
  expect(claimSlots(host.path)).toEqual({ held: 16, waiting: 0 });

  const handed = new AbortController();
  const handoff = transport.claim(request("handoff", handed.signal));
  held[0]!();
  handed.abort(new Error("aborted on handoff"));
  await expect(handoff).rejects.toThrow("aborted on handoff");
  expect(claimSlots(host.path)).toEqual({ held: 15, waiting: 0 });
  for (const release of held.slice(1)) release();
  expect(claimSlots(host.path)).toEqual({ held: 0, waiting: 0 });

  // The host holds the claim message unanswered, so the slot is provably still held.
  const unanswered = new AbortController();
  const attempt = transport.claim(request("unanswered", unanswered.signal));
  await host.arrived(1);
  expect(claimSlots(host.path)).toEqual({ held: 1, waiting: 0 });
  unanswered.abort(new Error("aborted while unanswered"));
  await expect(attempt).rejects.toThrow("aborted while unanswered");
  expect(claimSlots(host.path)).toEqual({ held: 0, waiting: 0 });

  const answered = transport.claim(request("answered"));
  await host.arrived(2);
  expect(claimSlots(host.path)).toEqual({ held: 1, waiting: 0 });
  host.resume();
  const later = await answered;
  expect(later.kind).toBe("connected");
  expect(claimSlots(host.path)).toEqual({ held: 0, waiting: 0 });
  if (later.kind === "connected") later.claim.close();
});

// Reason: the 2-second timer is what ends an attempt the host accepts but never answers. It must
// keep giving the unreachable floor and free the slot, or a hung host would stall the gate.
test("a host that never answers gives the unreachable floor after 2 seconds and frees the slot", async () => {
  const host = await liveHost({ paused: true });
  const transport = sharedWorkSocket({ directory: host.directory });
  const started = performance.now();
  const attempt = transport.claim(request("silent"));
  await host.arrived(1);
  expect(claimSlots(host.path)).toEqual({ held: 1, waiting: 0 });
  expect(await attempt).toEqual({ kind: "floor", reason: "unreachable" });
  const elapsedMs = Math.round(performance.now() - started);
  console.info(JSON.stringify({ case: "silent-host", elapsedMs }));
  expect(elapsedMs).toBeGreaterThanOrEqual(1990);
  expect(claimSlots(host.path)).toEqual({ held: 0, waiting: 0 });
});

// Reason: the disclosed exception in 0016 must keep working. With no host, every claim is the
// unreachable floor well before the 2-second connecting timeout, and no slot is left held.
test("an absent host gives every claim the unreachable floor promptly", async () => {
  const directory = scratch();
  const path = join(directory, "budget.sock");
  const transport = sharedWorkSocket({ directory });
  const started = performance.now();
  const [results, answers] = await Promise.all([
    Promise.all(
      Array.from({ length: 300 }, (_, index) =>
        transport.claim(request(`key-${index}`)),
      ),
    ),
    Promise.all(
      Array.from({ length: 50 }, (_, index) =>
        sharedWorkOwnership("store", `query-${index}`, directory),
      ),
    ),
  ]);
  const elapsedMs = Math.round(performance.now() - started);
  console.info(JSON.stringify({ case: "absent-host", elapsedMs }));
  expect(
    results.every(
      (result) => result.kind === "floor" && result.reason === "unreachable",
    ),
  ).toBe(true);
  expect(answers.every((answer) => answer === "unknown")).toBe(true);
  expect(elapsedMs).toBeLessThan(2000);
  expect(claimSlots(path)).toEqual({ held: 0, waiting: 0 });
  expect(querySlots(path)).toEqual({ held: 0, waiting: 0 });
});
