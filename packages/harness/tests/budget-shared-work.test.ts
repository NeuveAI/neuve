import { Observation, Request } from "../src/budget/scheduler.ts";
import { expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { z } from "zod";
import {
  hostBudget,
  workerBudget,
  closeWorkerBudget,
} from "../src/budget/local.ts";
import {
  canonicalStoreIdentity,
  sharedWorkSocket,
} from "@neuve/records-core/shared-work-socket";
import { SharedWorkMessage } from "@neuve/records-core/shared-work-protocol";
import {
  SharedWork,
  type SharedWorkTransport,
  type PublishedSharedOutcome,
} from "@neuve/records-core/shared-work";

const Event = z.object({
  event: z.string(),
  kind: z.string().optional(),
  role: z.string().optional(),
  outcome: z
    .union([
      z.string(),
      z.object({
        kind: z.string(),
        value: z.string().optional(),
        error: z.string().optional(),
      }),
    ])
    .optional(),
  reads: z.number().optional(),
  index: z.number().optional(),
  count: z.number().optional(),
  takeover: z.boolean().optional(),
  floor: z.string().optional(),
  redeclare: z.boolean().optional(),
  declaring: z.boolean().optional(),
});
type Event = z.infer<typeof Event>;
function child(directory: string, store: string, options: object = {}) {
  const events: Event[] = [];
  const listeners = new Set<() => void>();
  const process = Bun.spawn(
    [
      Bun.which("bun") ?? "bun",
      "--no-env-file",
      join(import.meta.dir, "fixtures/shared-work-process.ts"),
    ],
    {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...globalThis.process.env,
        NEUVE_BUDGET_DIRECTORY: directory,
        SHARED_WORK_TEST: JSON.stringify({ directory, store, ...options }),
      },
    },
  );
  const output = (async () => {
    const reader = process.stdout
      .pipeThrough(new TextDecoderStream())
      .getReader();
    let buffer = "";
    while (true) {
      const next = await reader.read();
      if (next.done) return;
      buffer += next.value;
      let index: number;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        const event = Event.safeParse(JSON.parse(line));
        if (event.success) events.push(event.data);
        for (const listener of listeners) listener();
      }
    }
  })();
  const wait = (predicate: (event: Event) => boolean) =>
    new Promise<Event>((resolve, reject) => {
      const inspect = () => {
        const event = events.find(predicate);
        if (event) {
          listeners.delete(inspect);
          resolve(event);
        }
      };
      listeners.add(inspect);
      inspect();
      void process.exited.then(async (code) => {
        await output;
        if (listeners.delete(inspect))
          reject(
            new Error(
              `Fixture exited ${code}: ${await new Response(process.stderr).text()}`,
            ),
          );
      });
    });
  return {
    events,
    process,
    wait,
    event: (name: string) => wait((event) => event.event === name),
    role: (name: string) =>
      wait((event) => event.event === "role" && event.role === name),
    send: (name: string) => {
      process.stdin.write(`${name}\n`);
      process.stdin.flush();
    },
    stop: async () => {
      process.kill("SIGKILL");
      await process.exited;
      await output;
    },
  };
}
type Child = ReturnType<typeof child>;
async function setup(hosted = true, ready = true) {
  const directory = mkdtempSync(join(tmpdir(), "sw-"));
  const store = join(directory, "store");
  mkdirSync(store);
  let host = hosted
    ? await hostBudget({ directory, threads: 2, fixed: 4 })
    : undefined;
  if (hosted && !host) throw new Error("Host missing");
  if (host && !ready) {
    await host.close();
    host = await hostBudget({ directory, threads: 2, fixed: 4 });
    if (!host) throw new Error("Replacement host missing");
  }
  if (ready) await host?.claims.ready;
  const children: Child[] = [];
  return {
    directory,
    store,
    host,
    children,
    spawn: (options: object = {}, data = store) => {
      const next = child(directory, data, options);
      children.push(next);
      return next;
    },
    close: async () => {
      await Promise.all(children.map((next) => next.stop()));
      await host?.close();
      await closeWorkerBudget(directory);
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
const count = (store: string, file = "executions") =>
  existsSync(join(store, file))
    ? readFileSync(join(store, file), "utf8").trim().split("\n").length
    : 0;
const resultPath = (store: string) =>
  join(store, `result-${Buffer.from("operation@1:input").toString("hex")}`);

function withdrawingHolder(
  s: Awaited<ReturnType<typeof setup>>,
  delaySend = false,
) {
  const withdrawn = Promise.withResolvers<void>();
  const deliver = Promise.withResolvers<void>();
  const requested = Promise.withResolvers<void>();
  const send = Promise.withResolvers<void>();
  const started = Promise.withResolvers<AbortSignal>();
  const aborted = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<"cancel" | "publish">();
  const ended = Promise.withResolvers<void>();
  const closed = Promise.withResolvers<void>();
  const settled = Promise.withResolvers<void>();
  const floor = Promise.withResolvers<void>();
  const socket = sharedWorkSocket({ directory: s.directory });
  const transport: SharedWorkTransport = {
    claim: async (input) => {
      const opened = await socket.claim(input);
      if (opened.kind !== "connected") return opened;
      const claim = opened.claim;
      return {
        kind: "connected",
        claim: {
          ...claim,
          withdraw: () => {
            requested.resolve();
            if (delaySend) void send.promise.then(() => claim.withdraw());
            else claim.withdraw();
          },
          next: async () => {
            const event = await claim.next();
            if (event.kind === "withdrawn") {
              withdrawn.resolve();
              await deliver.promise;
            }
            return event;
          },
          settle: async (outcome, publication) => {
            await claim.settle(outcome, publication);
            settled.resolve();
          },
          close: () => {
            claim.close();
            closed.resolve();
          },
        },
      };
    },
  };
  const publication = {
    publication: "withdrawal-race",
    outcome: { kind: "succeeded", value: "stored-result" },
  } as const;
  let stored = false;
  let executions = 0;
  let running = false;
  const work = new SharedWork<string>();
  const abort = new AbortController();
  const options = {
    scope: s.store,
    key: "operation@1:input",
    crossProcess: {
      store: s.store,
      transport,
      read: async () => (stored ? publication : undefined),
    },
    onEvent: (event: { role: string }) => {
      if (event.role === "floor") floor.resolve();
    },
    run: async (signal: AbortSignal) => {
      executions++;
      running = true;
      signal.addEventListener("abort", () => aborted.resolve(), { once: true });
      started.resolve(signal);
      try {
        if ((await finish.promise) === "cancel") throw signal.reason;
        writeFileSync(
          join(s.store, `published-${publication.publication}`),
          JSON.stringify(publication),
        );
        const temporary = join(s.store, "withdrawal.tmp");
        writeFileSync(temporary, JSON.stringify(publication));
        renameSync(temporary, resultPath(s.store));
        stored = true;
        return publication;
      } finally {
        running = false;
        ended.resolve();
      }
    },
  };
  const result = work
    .run({ ...options, signal: abort.signal })
    .catch(() => undefined);
  return {
    work,
    options,
    abort,
    result,
    withdrawn,
    deliver,
    requested,
    send,
    started,
    aborted,
    finish,
    ended,
    closed,
    settled,
    floor,
    get running() {
      return running;
    },
    get executions() {
      return executions;
    },
    cleanup: async () => {
      deliver.resolve();
      send.resolve();
      finish.resolve("cancel");
      abort.abort();
      await ended.promise;
      await closed.promise;
    },
  };
}

// A delayed withdrawal reply must not let another process execute beside the old run.
// A local caller queued behind withdrawal must reject promptly when its own signal aborts.
// One run shows both: the scenario is the same, so it is not started twice.
test("withdrawal reply in flight: no overlap, and the queued local caller is cancelled", async () => {
  const s = await setup();
  const h = withdrawingHolder(s);
  try {
    const running = await h.started.promise;
    h.abort.abort();
    await h.result;
    await h.withdrawn.promise;
    const localAbort = new AbortController();
    let localCancelled = false;
    const local = h.work
      .run({ ...h.options, signal: localAbort.signal })
      .catch(() => {
        localCancelled = true;
      });
    localAbort.abort();
    const fresh = s.spawn();
    const role = await fresh.wait(
      (event) =>
        event.event === "role" &&
        ["holder", "takeover", "waiter"].includes(event.role ?? ""),
    );
    if (role.role !== "waiter") await fresh.event("run");
    const observation = {
      case: "withdrawal-reply",
      oldRunStillActive: !running.aborted,
      newProcessStarted: fresh.events.some((event) => event.event === "run"),
      hostConnections: s.host?.claims.size,
      cancelledLocalCallerSettled: localCancelled,
    };
    console.info(JSON.stringify(observation));
    expect(observation.cancelledLocalCallerSettled).toBe(true);
    expect(observation.oldRunStillActive && observation.newProcessStarted).toBe(
      false,
    );
    await local;
  } finally {
    await h.cleanup();
    await s.close();
  }
}, 30_000);

// Cancellation is cooperative, so a late waiter can take over only after the old execution ends.
test("a waiter arriving after withdrawn waits for the old run to end", async () => {
  const s = await setup(false);
  await workerBudget(s.directory);
  const h = withdrawingHolder(s);
  try {
    await h.started.promise;
    h.abort.abort();
    await h.result;
    await h.withdrawn.promise;
    h.deliver.resolve();
    await h.aborted.promise;
    expect(await closeWorkerBudget(s.directory)).toBe(false);
    const waiter = s.spawn({ pauseRun: false });
    await waiter.role("waiter");
    expect(h.running).toBe(true);
    expect(await closeWorkerBudget(s.directory)).toBe(false);
    expect(waiter.events.some((event) => event.event === "run")).toBe(false);
    h.finish.resolve("cancel");
    await h.ended.promise;
    await waiter.event("takeover-hook");
    expect(h.running).toBe(false);
    await waiter.event("result");
    expect(count(s.store)).toBe(1);
    expect(count(s.store, "takeovers")).toBe(1);
    expect(await closeWorkerBudget(s.directory)).toBe(true);
    console.info(
      JSON.stringify({
        case: "withdrawn-late-waiter",
        oldRunEnded: !h.running,
        newExecutions: count(s.store),
        takeovers: count(s.store, "takeovers"),
      }),
    );
  } finally {
    await h.cleanup();
    await s.close();
  }
}, 30_000);

// A stored outcome must settle and wake waiters even when withdrawal or cooperative abort races it.
for (const afterAbort of [false, true])
  test(`publication settles during withdrawal, after abort=${afterAbort}`, async () => {
    const s = await setup();
    const h = withdrawingHolder(s);
    try {
      const signal = await h.started.promise;
      h.abort.abort();
      await h.result;
      await h.withdrawn.promise;
      if (afterAbort) {
        h.deliver.resolve();
        await h.aborted.promise;
      }
      const waiter = s.spawn({ pauseRun: false });
      await waiter.role("waiter");
      const local = h.work.run(h.options);
      h.finish.resolve("publish");
      await h.settled.promise;
      expect(signal.aborted).toBe(afterAbort);
      h.deliver.resolve();
      expect((await waiter.event("result")).outcome).toEqual({
        kind: "succeeded",
        value: "stored-result",
      });
      expect((await local).outcome).toEqual({
        kind: "succeeded",
        value: "stored-result",
      });
      expect(h.executions).toBe(1);
      expect(count(s.store)).toBe(0);
      expect(count(s.store, "takeovers")).toBe(0);
      console.info(
        JSON.stringify({
          case: "withdrawal-settle",
          afterAbort,
          executions: h.executions,
          remoteExecutions: count(s.store),
          takeovers: count(s.store, "takeovers"),
        }),
      );
    } finally {
      await h.cleanup();
      await s.close();
    }
  }, 30_000);

// Host loss must release queued local demand and recover the running holder without treating it as failure.
test("host loss races an outstanding withdrawal with queued local demand", async () => {
  const s = await setup();
  const h = withdrawingHolder(s, true);
  try {
    const signal = await h.started.promise;
    h.abort.abort();
    await h.result;
    await h.requested.promise;
    const local = h.work.run(h.options);
    await s.host?.close();
    await h.floor.promise;
    expect(signal.aborted).toBe(false);
    h.finish.resolve("publish");
    expect(await local).toEqual({
      outcome: { kind: "succeeded", value: "stored-result" },
      floor: "unreachable",
    });
    expect(h.executions).toBe(1);
    console.info(
      JSON.stringify({
        case: "withdrawal-host-loss",
        runAborted: signal.aborted,
        executions: h.executions,
        floor: "unreachable",
      }),
    );
  } finally {
    await h.cleanup();
    await s.close();
  }
}, 30_000);

// A pushed publication must share one execution and cause exactly one post-push store read.
test("two processes share one run and the publication push wakes a blocked waiter", async () => {
  const s = await setup();
  try {
    const holder = s.spawn();
    await holder.event("run");
    const waiter = s.spawn();
    await waiter.role("waiter");
    expect(
      waiter.events.filter((event) => event.event === "read"),
    ).toHaveLength(1);
    expect(count(s.store)).toBe(1);
    holder.send("run");
    const [one, two] = await Promise.all([
      holder.event("result"),
      waiter.event("result"),
    ]);
    expect(one.outcome).toEqual({ kind: "succeeded", value: "stored-result" });
    expect(two.outcome).toEqual(one.outcome);
    expect(two.reads).toBe(2);
    expect(count(s.store)).toBe(1);
    expect(
      holder.events.findIndex((e) => e.event === "published"),
    ).toBeLessThan(holder.events.findIndex((e) => e.event === "settle"));
  } finally {
    await s.close();
  }
}, 30_000);

// Recorded failure belongs to the attempt; only an explicit caller retry may start another run.
test("stored failure reaches every waiter without retry, and a later retry claims again", async () => {
  const s = await setup();
  try {
    const holder = s.spawn({ failed: true });
    await holder.event("run");
    const waiters = [s.spawn(), s.spawn()];
    await Promise.all(waiters.map((waiter) => waiter.role("waiter")));
    holder.send("run");
    const results = await Promise.all(
      [holder, ...waiters].map((next) => next.event("result")),
    );
    expect(results.map((event) => event.outcome)).toEqual(
      Array.from({ length: 3 }, () => ({
        kind: "failed",
        error: "attempt-failed",
      })),
    );
    expect(count(s.store)).toBe(1);
    unlinkSync(resultPath(s.store));
    const retry = s.spawn({ pauseRun: false });
    expect((await retry.event("result")).outcome).toEqual({
      kind: "succeeded",
      value: "stored-result",
    });
    expect(count(s.store)).toBe(2);
  } finally {
    await s.close();
  }
}, 30_000);

// A dead holder transfers its connection claim to the first live waiter, never to both.
test("SIGKILL transfers to the first waiter, runs its takeover hook, and preserves the next waiter", async () => {
  const s = await setup();
  try {
    const holder = s.spawn();
    await holder.event("run");
    const first = s.spawn();
    await first.role("waiter");
    const second = s.spawn();
    await second.role("waiter");
    await holder.stop();
    await first.event("takeover-hook");
    await first.event("run");
    expect(second.events.some((e) => e.event === "run")).toBe(false);
    first.send("run");
    await Promise.all([first.event("result"), second.event("result")]);
    expect(count(s.store)).toBe(2);
    expect(count(s.store, "takeovers")).toBe(1);
  } finally {
    await s.close();
  }
}, 30_000);

// Remote demand must keep a run alive after its own process's subscribers cancel.
test("remote waiter keeps running work alive after the holder's caller leaves", async () => {
  const s = await setup();
  try {
    const holder = s.spawn();
    await holder.event("run");
    const waiter = s.spawn();
    await waiter.role("waiter");
    await holder.wait(
      (event) =>
        event.event === "push" && event.kind === "waiters" && event.count === 1,
    );
    holder.send("cancel");
    await holder.event("rejected");
    expect(holder.events.some((e) => e.event === "cancelled-run")).toBe(false);
    holder.send("run");
    await waiter.event("result");
    expect(count(s.store)).toBe(1);
  } finally {
    await s.close();
  }
}, 30_000);

// A registered waiter must preserve demand even before its count reaches the holder.
test("a registered remote waiter preserves the run before its count push is consumed", async () => {
  const s = await setup();
  const countReceived = Promise.withResolvers<void>();
  const deliverCount = Promise.withResolvers<void>();
  const retained = Promise.withResolvers<number>();
  const began = Promise.withResolvers<AbortSignal>();
  const complete = Promise.withResolvers<void>();
  const finished = Promise.withResolvers<void>();
  const transport = sharedWorkSocket({ directory: s.directory });
  const delayed: SharedWorkTransport = {
    claim: async (input) => {
      const opened = await transport.claim(input);
      if (opened.kind !== "connected") return opened;
      const claim = opened.claim;
      return {
        kind: "connected",
        claim: {
          ...claim,
          next: async () => {
            const event = await claim.next();
            if (event.kind === "waiters" && event.count === 1) {
              countReceived.resolve();
              await deliverCount.promise;
            }
            if (event.kind === "retained") retained.resolve(event.count);
            return event;
          },
          settle: async (outcome, publication) => {
            await claim.settle(outcome, publication);
            finished.resolve();
          },
        },
      };
    },
  };
  const abort = new AbortController();
  let executions = 0;
  const pending = new SharedWork<string>()
    .run({
      scope: s.store,
      key: "operation@1:input",
      signal: abort.signal,
      crossProcess: {
        store: s.store,
        transport: delayed,
        read: async () => undefined,
      },
      run: async (signal) => {
        executions++;
        began.resolve(signal);
        await complete.promise;
        signal.throwIfAborted();
        const published = {
          publication: "count-in-flight",
          outcome: { kind: "succeeded", value: "stored-result" },
        } as const;
        writeFileSync(
          join(s.store, "published-count-in-flight"),
          JSON.stringify(published),
        );
        const temporary = join(s.store, "result-count-in-flight.tmp");
        writeFileSync(temporary, JSON.stringify(published));
        renameSync(temporary, resultPath(s.store));
        return published;
      },
    })
    .catch(() => undefined);
  try {
    const signal = await began.promise;
    const waiter = s.spawn();
    await countReceived.promise;
    await waiter.role("waiter");
    expect(s.host?.claims.size).toBe(2);
    abort.abort();
    await pending;
    expect(signal.aborted).toBe(false);
    deliverCount.resolve();
    expect(await retained.promise).toBe(1);
    expect(signal.aborted).toBe(false);
    complete.resolve();
    expect((await waiter.event("result")).outcome).toEqual({
      kind: "succeeded",
      value: "stored-result",
    });
    await finished.promise;
    expect(executions).toBe(1);
    expect(count(s.store)).toBe(0);
    expect(waiter.events.some((event) => event.event === "takeover-hook")).toBe(
      false,
    );
    console.info(
      JSON.stringify({
        case: "remote-count-in-flight",
        runAborted: signal.aborted,
        holderExecutions: executions,
        remoteExecutions: count(s.store),
        remoteTakeovers: count(s.store, "takeovers"),
      }),
    );
  } finally {
    deliverCount.resolve();
    complete.resolve();
    await s.close();
  }
}, 30_000);

// With no remote demand, cancellation aborts after withdrawal and releases the claim after the run ends.
test("a holder with no other waiters withdraws cleanly", async () => {
  const s = await setup();
  try {
    const holder = s.spawn();
    await holder.event("run");
    holder.send("cancel");
    await holder.event("rejected");
    await holder.event("cancelled-run");
    const withdrawn = holder.events.findIndex(
      (event) => event.event === "push" && event.kind === "withdrawn",
    );
    expect(withdrawn).toBeGreaterThanOrEqual(0);
    expect(withdrawn).toBeLessThan(
      holder.events.findIndex((event) => event.event === "cancelled-run"),
    );
    expect(existsSync(resultPath(s.store))).toBe(false);
    const fresh = s.spawn({ pauseRun: false });
    await fresh.event("result");
    expect(s.host?.claims.size).toBe(0);
    expect(fresh.events.some((event) => event.event === "takeover-hook")).toBe(
      false,
    );
    expect(count(s.store)).toBe(2);
  } finally {
    await s.close();
  }
}, 30_000);

// Losing the final remote subscriber must also cancel work that has no local subscribers.
test("last remote waiter leaving cancels the holder's unused run", async () => {
  const s = await setup();
  try {
    const holder = s.spawn();
    await holder.event("run");
    const waiter = s.spawn();
    await waiter.role("waiter");
    await holder.wait(
      (event) =>
        event.event === "push" && event.kind === "waiters" && event.count === 1,
    );
    holder.send("cancel");
    await holder.event("rejected");
    waiter.send("cancel");
    await waiter.event("rejected");
    await holder.event("cancelled-run");
    expect(existsSync(resultPath(s.store))).toBe(false);
  } finally {
    await s.close();
  }
}, 30_000);

// Floor execution must disclose its cause while retaining in-process coalescing.
test("unreachable host computes at the disclosed floor and shares inside the process", async () => {
  const s = await setup(false);
  try {
    const client = s.spawn({ locals: 2 });
    await client.event("run");
    client.send("run");
    await client.wait((event) => event.event === "result" && event.index === 1);
    expect(
      client.events
        .filter((event) => event.event === "result")
        .map((event) => event.floor),
    ).toEqual(["unreachable", "unreachable"]);
    expect(
      client.events.some(
        (event) =>
          event.event === "role" &&
          event.role === "floor" &&
          event.floor === "unreachable",
      ),
    ).toBe(true);
    expect(client.events.filter((e) => e.event === "connection")).toHaveLength(
      1,
    );
    expect(count(s.store)).toBe(1);
    expect(existsSync(join(s.directory, "budget.sqlite"))).toBe(false);
  } finally {
    await s.close();
  }
}, 15_000);

// Strict old hosts reject new kinds; clients must compute at the floor without electing another host.
test("old strict protocol returns error and the client discloses old-host floor", async () => {
  const s = await setup(false);
  let connections = 0;
  // The base host's full strict protocol. New kinds must take its existing error path.
  const OldMessage = z.discriminatedUnion("kind", [
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
  const server = createServer((socket) => {
    connections++;
    socket.once("data", (data) => {
      expect(
        OldMessage.safeParse(JSON.parse(data.toString().trim())).success,
      ).toBe(false);
      socket.end('{"kind":"error"}\n');
    });
  });
  await new Promise<void>((resolve) =>
    server.listen(join(s.directory, "budget.sock"), resolve),
  );
  try {
    const client = s.spawn({ pauseRun: false });
    expect((await client.event("result")).floor).toBe("old-host");
    expect(connections).toBe(1);
    expect(existsSync(join(s.directory, "budget.sqlite"))).toBe(false);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await s.close();
  }
}, 15_000);

// A grant holder must skip another process's key immediately instead of waiting behind it.
test("inside a grant gets KeyHeld across processes", async () => {
  const s = await setup();
  try {
    const holder = s.spawn();
    await holder.event("run");
    const grant = s.spawn({ insideGrant: true });
    expect((await grant.event("rejected")).kind).toBe("KeyHeld");
    expect(grant.events.some((event) => event.event === "run")).toBe(false);
    expect(grant.events.some((event) => event.role === "waiter")).toBe(false);
    holder.send("run");
    await holder.event("result");
  } finally {
    await s.close();
  }
}, 30_000);

// Worker idle shutdown must account for both unheld queued claims and live holders.
test("worker idle exit refuses a claim or waiter, then closes once publication ends", async () => {
  const s = await setup(false);
  try {
    const first = await hostBudget({
      directory: s.directory,
      threads: 2,
      fixed: 4,
    });
    if (!first) throw new Error("First host missing");
    await first.close();
    await workerBudget(s.directory);
    const holder = s.spawn();
    await holder.role("waiter");
    expect(await closeWorkerBudget(s.directory)).toBe(false);
    await holder.event("run");
    const waiter = s.spawn();
    await waiter.role("waiter");
    expect(await closeWorkerBudget(s.directory)).toBe(false);
    holder.send("run");
    await Promise.all([holder.event("result"), waiter.event("result")]);
    expect(await closeWorkerBudget(s.directory)).toBe(true);
  } finally {
    await s.close();
  }
}, 30_000);

// A successful or failed attempt may wake waiters only after its atomic publication commits.
for (const failed of [false, true])
  for (const failPublication of [false, true])
    test(`publication ordering, failed=${failed}, failPublication=${failPublication}`, async () => {
      const s = await setup();
      try {
        const holder = s.spawn({ failed, pausePublish: true, failPublication });
        await holder.event("run");
        const waiter = s.spawn({ failed });
        await waiter.role("waiter");
        holder.send("run");
        await holder.event("before-publish");
        expect(
          waiter.events.filter((event) => event.event === "read"),
        ).toHaveLength(1);
        expect(waiter.events.some((event) => event.kind === "done")).toBe(
          false,
        );
        expect(existsSync(resultPath(s.store))).toBe(false);
        holder.send("publish");
        if (failPublication) {
          expect((await holder.event("rejected")).kind).toBe("publication");
          await waiter.event("takeover-hook");
          await waiter.event("run");
          expect(holder.events.some((event) => event.event === "settle")).toBe(
            false,
          );
          waiter.send("run");
        } else {
          await holder.event("result");
          expect(waiter.events.some((event) => event.event === "run")).toBe(
            false,
          );
        }
        expect((await waiter.event("result")).outcome).toEqual(
          failed
            ? { kind: "failed", error: "attempt-failed" }
            : { kind: "succeeded", value: "stored-result" },
        );
      } finally {
        await s.close();
      }
    }, 30_000);

// A host's single startup window lets a surviving holder re-declare before queued fresh callers run.
test("five-second re-declaration window queues fresh callers and honors a surviving holder", async () => {
  const s = await setup(true, false);
  try {
    const waiter = s.spawn();
    await waiter.role("waiter");
    const transport = sharedWorkSocket({ directory: s.directory });
    const opened = await transport.claim({
      store: s.store,
      key: "operation@1:input",
      insideGrant: false,
      redeclare: true,
      signal: new AbortController().signal,
    });
    if (opened.kind !== "connected") throw new Error("No claim");
    expect((await opened.claim.next()).kind).toBe("claimed");
    expect(waiter.events.some((event) => event.event === "run")).toBe(false);
    writeStored(s.store);
    await opened.claim.settle("succeeded", "fixture");
    expect((await waiter.event("result")).reads).toBe(2);
    opened.claim.close();
    expect(count(s.store)).toBe(0);
  } finally {
    await s.close();
  }
}, 15_000);
function writeStored(store: string) {
  const published = JSON.stringify({
    publication: "fixture",
    outcome: { kind: "succeeded", value: "stored-result" },
  });
  writeFileSync(join(store, "published-fixture"), published);
  writeFileSync(resultPath(store), published);
}

// Canonical checkout aliases must share, while stores and changed input/version keys stay independent.
test("canonical store aliases share a run and stores, versions and inputs remain isolated", async () => {
  const s = await setup();
  const repo = join(s.directory, "repo"),
    alias = join(s.directory, "alias"),
    tree = join(s.directory, "tree");
  mkdirSync(repo);
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", "-C", repo, ...args], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
    });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  };
  try {
    git("init");
    git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "--allow-empty",
      "-m",
      "fixture",
    );
    git("worktree", "add", "--detach", tree);
    symlinkSync(repo, alias);
    expect(await canonicalStoreIdentity(alias)).toBe(
      await canonicalStoreIdentity(tree),
    );
    const holder = s.spawn({ repository: alias });
    await holder.event("run");
    const waiter = s.spawn({ repository: tree });
    await waiter.role("waiter");
    holder.send("run");
    await Promise.all([holder.event("result"), waiter.event("result")]);
    expect(count(s.store)).toBe(1);
    const other = join(s.directory, "other");
    mkdirSync(other);
    const independent = [
      s.spawn({ pauseRun: false }, other),
      s.spawn({ key: "operation@2:input", pauseRun: false }),
      s.spawn({ key: "operation@1:changed", pauseRun: false }),
    ];
    await Promise.all(independent.map((c) => c.event("result")));
    expect(count(s.store)).toBe(3);
    expect(count(other)).toBe(1);
    const wire = SharedWorkMessage.parse({
      version: 1,
      kind: "claim",
      store: "a".repeat(64),
      key: "b".repeat(64),
      insideGrant: false,
    });
    expect(Buffer.byteLength(JSON.stringify(wire))).toBeLessThan(8192);
  } finally {
    await s.close();
  }
}, 30_000);

// Host death is a transport event: live work continues while a worker re-elects and re-declares it.
test("host SIGKILL recovers through the worker, re-declares the holder, and wakes the waiter", async () => {
  const s = await setup(false);
  try {
    const old = s.spawn({ host: true });
    await old.event("ready");
    const holder = s.spawn({ worker: true });
    await holder.event("run");
    const waiter = s.spawn({ gatedRecovery: true });
    await waiter.role("waiter");
    await old.stop();
    await holder.event("redeclared");
    await waiter.event("recovering");
    waiter.send("recover");
    await waiter.wait(
      (event) =>
        event.event === "connection" &&
        waiter.events.filter((e) => e.event === "connection").length === 2,
    );
    holder.send("run");
    await holder.event("result");
    const result = await waiter.event("result");
    expect(result.outcome).toEqual({
      kind: "succeeded",
      value: "stored-result",
    });
    expect(holder.events.some((event) => event.event === "rejected")).toBe(
      false,
    );
    expect(waiter.events.some((event) => event.event === "rejected")).toBe(
      false,
    );
    expect(result.floor).toBeUndefined();
    expect(result.reads).toBe(3);
    expect(
      waiter.events.some(
        (event) => event.event === "push" && event.kind === "done",
      ),
    ).toBe(true);
    expect(count(s.store)).toBe(1);
  } finally {
    await s.close();
  }
}, 30_000);

// A waiter surviving both its holder and the host must clean up the dead attempt before running.
test("holder and host loss still invokes per-key takeover", async () => {
  const s = await setup(false);
  let replacement: Awaited<ReturnType<typeof hostBudget>>;
  try {
    const old = s.spawn({ host: true });
    await old.event("ready");
    const holder = s.spawn();
    await holder.event("run");
    const waiter = s.spawn({ gatedRecovery: true });
    await waiter.role("waiter");
    await old.stop();
    await holder.stop();
    await waiter.event("recovering");
    replacement = await hostBudget({
      directory: s.directory,
      threads: 2,
      fixed: 4,
    });
    if (!replacement) throw new Error("No replacement host");
    waiter.send("recover");
    const run = await waiter.event("run");
    console.info(
      JSON.stringify({ case: "holder-and-host-loss", events: waiter.events }),
    );
    expect(waiter.events.some((event) => event.event === "takeover-hook")).toBe(
      true,
    );
    const hookIndex = waiter.events.findIndex(
      (event) => event.event === "takeover-hook",
    );
    expect(hookIndex).toBeLessThan(waiter.events.indexOf(run));
    expect(waiter.events[hookIndex - 1]?.event).toBe("read");
    expect(
      waiter.events.filter((event) => event.role === "takeover"),
    ).toHaveLength(1);
    expect(count(s.store, "takeovers")).toBe(1);
    waiter.send("run");
    expect((await waiter.event("result")).outcome).toEqual({
      kind: "succeeded",
      value: "stored-result",
    });
    expect(count(s.store)).toBe(2);
  } finally {
    await s.close();
    await replacement?.close();
  }
}, 60_000);

// A surviving holder gets one re-declaration attempt and finishes at the floor if nobody hosts.
test("holder survives host loss without a worker and discloses the floor once", async () => {
  const s = await setup(false);
  try {
    const old = s.spawn({ host: true });
    await old.event("ready");
    const holder = s.spawn();
    await holder.event("run");
    await old.stop();
    await holder.role("floor");
    holder.send("run");
    expect((await holder.event("result")).floor).toBe("unreachable");
    expect(
      holder.events.filter(
        (event) => event.event === "connection" && event.redeclare,
      ),
    ).toHaveLength(1);
    expect(count(s.store)).toBe(1);
  } finally {
    await s.close();
  }
}, 30_000);

// Death after commit but before settle must reuse the stored outcome rather than execute again.
test("takeover re-reads a committed outcome before its hook or run", async () => {
  const s = await setup();
  try {
    const opened = await sharedWorkSocket({ directory: s.directory }).claim({
      store: s.store,
      key: "operation@1:input",
      insideGrant: false,
      redeclare: false,
      signal: new AbortController().signal,
    });
    if (opened.kind !== "connected") throw new Error("No claim");
    expect((await opened.claim.next()).kind).toBe("claimed");
    const waiter = s.spawn();
    await waiter.role("waiter");
    writeStored(s.store);
    opened.claim.close();
    expect((await waiter.event("result")).outcome).toEqual({
      kind: "succeeded",
      value: "stored-result",
    });
    expect(
      waiter.events.some(
        (event) => event.event === "takeover-hook" || event.event === "run",
      ),
    ).toBe(false);
    expect(count(s.store)).toBe(0);
  } finally {
    await s.close();
  }
}, 30_000);

// A retry must not replace the failure an earlier waiter has been pushed to read.
test("a slow waiter receives its attempt's failure even after a successful retry publishes", async () => {
  const s = await setup();
  try {
    const holder = s.spawn({ failed: true });
    await holder.event("run");
    const waiter = s.spawn({ pauseRead: true });
    await waiter.role("waiter");
    holder.send("run");
    await holder.event("result");
    await waiter.event("before-read");
    unlinkSync(resultPath(s.store));
    const retry = s.spawn({ pauseRun: false });
    expect((await retry.event("result")).outcome).toEqual({
      kind: "succeeded",
      value: "stored-result",
    });
    waiter.send("read");
    expect((await waiter.event("result")).outcome).toEqual({
      kind: "failed",
      error: "attempt-failed",
    });
    expect(count(s.store)).toBe(2);
  } finally {
    await s.close();
  }
}, 30_000);

// A pre-claim read can race a complete publication, so acquiring a fresh key must re-read too.
test("publication between the first read and claim acquisition is reused", async () => {
  const s = await setup();
  try {
    const delayed = s.spawn({ pauseClaim: true });
    await delayed.event("before-claim");
    const holder = s.spawn({ pauseRun: false });
    await holder.event("result");
    delayed.send("claim");
    expect((await delayed.event("result")).outcome).toEqual({
      kind: "succeeded",
      value: "stored-result",
    });
    expect(delayed.events.some((event) => event.event === "run")).toBe(false);
    expect(count(s.store)).toBe(1);
  } finally {
    await s.close();
  }
}, 30_000);

// A late re-declaration cannot settle another holder's claim or fail already running work.
test("a holder that misses re-declaration keeps running and discloses host-changed", async () => {
  const s = await setup();
  let replacement: Awaited<ReturnType<typeof hostBudget>>;
  try {
    const holder = s.spawn({ gatedRecovery: true });
    await holder.event("run");
    await s.host?.close();
    await holder.event("recovering");
    replacement = await hostBudget({
      directory: s.directory,
      threads: 2,
      fixed: 4,
    });
    if (!replacement) throw new Error("No replacement host");
    const claimed = await sharedWorkSocket({ directory: s.directory }).claim({
      store: s.store,
      key: "operation@1:input",
      insideGrant: false,
      redeclare: true,
      signal: new AbortController().signal,
    });
    if (claimed.kind !== "connected") throw new Error("No replacement claim");
    expect((await claimed.claim.next()).kind).toBe("claimed");
    holder.send("recover");
    await holder.role("floor");
    holder.send("run");
    expect((await holder.event("result")).floor).toBe("host-changed");
    expect(holder.events.some((event) => event.event === "settle")).toBe(false);
    expect(count(s.store)).toBe(1);
    claimed.claim.close();
  } finally {
    await s.close();
    await replacement?.close();
  }
}, 30_000);

// Surviving remote demand must remain sufficient during the host replacement window.
test("local cancellation preserves remote demand during host recovery", async () => {
  const s = await setup();
  let replacement: Awaited<ReturnType<typeof hostBudget>>;
  try {
    const holder = s.spawn({ gatedRecovery: true });
    await holder.event("run");
    const waiter = s.spawn({ gatedRecovery: true });
    await waiter.role("waiter");
    await holder.wait(
      (e) => e.event === "push" && e.kind === "waiters" && e.count === 1,
    );
    await s.host?.close();
    await Promise.all([holder.event("recovering"), waiter.event("recovering")]);
    replacement = await hostBudget({
      directory: s.directory,
      threads: 2,
      fixed: 4,
    });
    if (!replacement) throw new Error("No replacement");
    holder.send("recover");
    await holder.event("redeclared");
    holder.send("cancel");
    await holder.event("rejected");
    waiter.send("recover");
    await waiter.wait(
      (e) =>
        e.event === "connection" &&
        waiter.events.filter((e) => e.event === "connection").length === 2,
    );
    holder.send("run");
    waiter.send("run");
    const result = await waiter.event("result");
    console.info(
      JSON.stringify({
        case: "remote-only-recovery",
        holder: holder.events,
        waiter: waiter.events,
        executions: count(s.store),
      }),
    );
    expect(result.outcome).toEqual({
      kind: "succeeded",
      value: "stored-result",
    });
    expect(holder.events.some((e) => e.event === "cancelled-run")).toBe(false);
    expect(count(s.store)).toBe(1);
  } finally {
    await s.close();
    await replacement?.close();
  }
}, 30_000);

// Each new host gets the same ownership re-declaration, even during a long-running attempt.
test("a live holder re-declares after a second host replacement", async () => {
  const s = await setup();
  let second: Awaited<ReturnType<typeof hostBudget>>;
  let third: Awaited<ReturnType<typeof hostBudget>>;
  try {
    const holder = s.spawn({ gatedRecovery: true, gateSecondLoss: true });
    await holder.event("run");
    await s.host?.close();
    await holder.event("recovering");
    second = await hostBudget({ directory: s.directory, threads: 2, fixed: 4 });
    if (!second) throw new Error("No second host");
    holder.send("recover");
    await holder.event("redeclared");
    await second.close();
    await holder.event("before-second-loss");
    third = await hostBudget({ directory: s.directory, threads: 2, fixed: 4 });
    if (!third) throw new Error("No third host");
    holder.send("second-loss");
    await holder.wait(
      (e) =>
        (e.event === "role" && e.role === "floor") ||
        (e.event === "connection" &&
          holder.events.filter((e) => e.event === "connection" && e.redeclare)
            .length === 2),
    );
    await third.claims.ready;
    const waiter = s.spawn({ insideGrant: true, pauseRun: false });
    const response = await waiter.wait(
      (e) => e.event === "result" || e.event === "rejected",
    );
    holder.send("run");
    await holder.event("result");
    console.info(
      JSON.stringify({
        case: "second-host-loss",
        holder: holder.events,
        waiter: waiter.events,
        executions: count(s.store),
      }),
    );
    expect(response.kind).toBe("KeyHeld");
    expect(count(s.store)).toBe(1);
    expect(
      holder.events.filter((e) => e.event === "connection" && e.redeclare),
    ).toHaveLength(2);
  } finally {
    await s.close();
    await second?.close();
    await third?.close();
  }
}, 60_000);

// Old remote demand expires only after the replacement host pushes its final count.
for (const withdrawInWindow of [false, true])
  test(`replacement window clears prior demand, waiter reconnects and withdraws=${withdrawInWindow}`, async () => {
    const s = await setup();
    let replacement: Awaited<ReturnType<typeof hostBudget>>;
    try {
      const holder = s.spawn({ gatedRecovery: true });
      await holder.event("run");
      const waiter = s.spawn({ gatedRecovery: true });
      await waiter.role("waiter");
      await holder.wait(
        (e) => e.event === "push" && e.kind === "waiters" && e.count === 1,
      );
      await s.host?.close();
      await Promise.all([
        holder.event("recovering"),
        waiter.event("recovering"),
      ]);
      replacement = await hostBudget({
        directory: s.directory,
        threads: 2,
        fixed: 4,
      });
      if (!replacement) throw new Error("No replacement host");
      holder.send("recover");
      await holder.event("redeclared");
      holder.send("cancel");
      await holder.event("rejected");
      if (withdrawInWindow) {
        waiter.send("recover");
        await holder.wait(
          (e) =>
            e.event === "push" &&
            e.kind === "waiters" &&
            e.count === 1 &&
            e.declaring === true,
        );
        waiter.send("cancel");
        await waiter.event("rejected");
        await holder.wait(
          (e) =>
            e.event === "push" &&
            e.kind === "waiters" &&
            e.count === 0 &&
            e.declaring === true,
        );
      }
      await replacement.claims.ready;
      const finalCount = await holder.wait(
        (e) =>
          e.event === "push" &&
          e.kind === "waiters" &&
          e.count === 0 &&
          e.declaring === false,
      );
      const cancelled = await holder.event("cancelled-run");
      expect(holder.events.indexOf(finalCount)).toBeLessThan(
        holder.events.indexOf(cancelled),
      );
      expect(count(s.store)).toBe(1);
      expect(existsSync(resultPath(s.store))).toBe(false);
    } finally {
      await s.close();
      await replacement?.close();
    }
  }, 60_000);

// The disclosed floor must retain correct local cancellation and sharing.
test("a fresh floor caller waits for cancelled work to end and runs a live attempt", async () => {
  const s = await setup(false);
  const work = new SharedWork<number>();
  const began = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const controller = new AbortController();
  let executions = 0;
  const options = {
    scope: s.store,
    key: "key",
    crossProcess: {
      store: s.store,
      transport: sharedWorkSocket({ directory: s.directory }),
      read: async () => undefined,
    },
    run: async (
      signal: AbortSignal,
    ): Promise<PublishedSharedOutcome<number, never>> => {
      const value = ++executions;
      if (value === 1) {
        began.resolve();
        await finish.promise;
      }
      signal.throwIfAborted();
      return {
        publication: `attempt-${value}`,
        outcome: { kind: "succeeded", value },
      };
    },
  };
  try {
    const old = work
      .run({ ...options, signal: controller.signal })
      .catch(() => undefined);
    await began.promise;
    controller.abort();
    const fresh = work.run(options).then(
      (result) => ({ kind: "result", result }),
      (error: Error) => ({ kind: "rejected", name: error.name }),
    );
    expect(executions).toBe(1);
    finish.resolve();
    await old;
    const observed = await fresh;
    console.info(
      JSON.stringify({
        case: "fresh-floor-after-cancel",
        observed,
        executions,
      }),
    );
    expect(observed).toEqual({
      kind: "result",
      result: {
        outcome: { kind: "succeeded", value: 2 },
        floor: "unreachable",
      },
    });
    expect(executions).toBe(2);
  } finally {
    controller.abort();
    finish.resolve();
    await s.close();
  }
}, 15_000);

// A fresh local caller must wait for a stopping claim holder, with cancellation of its own.
for (const cancelFresh of [false, true])
  test(`a fresh caller waits for a stopping claim holder, cancel fresh=${cancelFresh}`, async () => {
    const s = await setup();
    const h = withdrawingHolder(s);
    const freshAbort = new AbortController();
    const cancelled = new Error("fresh caller cancelled");
    const publication = {
      publication: "fresh-attempt",
      outcome: { kind: "succeeded", value: "fresh-result" },
    } satisfies PublishedSharedOutcome<string, never>;
    let stored: PublishedSharedOutcome<string, never> | undefined;
    let freshExecutions = 0;
    let reads = 0;
    const options = {
      ...h.options,
      crossProcess: {
        ...h.options.crossProcess,
        read: async () => {
          reads++;
          return stored;
        },
      },
      run: async (signal: AbortSignal) => {
        expect(h.running).toBe(false);
        expect(signal.aborted).toBe(false);
        freshExecutions++;
        const temporary = join(s.store, "fresh.tmp");
        writeFileSync(temporary, JSON.stringify(publication));
        renameSync(temporary, resultPath(s.store));
        stored = publication;
        return publication;
      },
    };
    try {
      await h.started.promise;
      h.abort.abort();
      await h.result;
      await h.withdrawn.promise;
      h.deliver.resolve();
      await h.aborted.promise;
      const fresh = h.work.run({ ...options, signal: freshAbort.signal });
      if (cancelFresh) {
        const rejected = fresh.catch((cause: unknown) => cause);
        freshAbort.abort(cancelled);
        expect(await rejected).toBe(cancelled);
      }
      expect(h.running).toBe(true);
      expect(freshExecutions).toBe(0);
      expect(reads).toBe(0);
      expect(s.host?.claims.size).toBe(1);
      h.finish.resolve("cancel");
      await h.ended.promise;
      // Also prove a cancelled queued caller has left no execution behind it.
      const result = cancelFresh ? await h.work.run(options) : await fresh;
      expect(result).toEqual({
        outcome: { kind: "succeeded", value: "fresh-result" },
      });
      expect(h.executions).toBe(1);
      expect(freshExecutions).toBe(1);
      expect(reads).toBe(2);
      expect(readFileSync(resultPath(s.store), "utf8")).toBe(
        JSON.stringify(publication),
      );
      console.info(
        JSON.stringify({
          case: "fresh-stopping-holder",
          cancelFresh,
          oldRunEnded: !h.running,
          oldExecutions: h.executions,
          freshExecutions,
          reads,
        }),
      );
    } finally {
      freshAbort.abort();
      await h.cleanup();
      await s.close();
    }
  }, 30_000);
