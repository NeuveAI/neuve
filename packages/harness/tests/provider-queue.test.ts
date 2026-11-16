// The provider queue's bands, linger and fair share decide who waits; only a run in virtual time shows it.
import { expect, test } from "bun:test";
import {
  Scheduler,
  type Grant,
  type Request,
  type SchedulerOptions,
  type Timers,
} from "../src/budget/scheduler.ts";
import { reviewPriority } from "../src/pi/priority.ts";
import { FULL, simulate, type Outcome } from "../scripts/scheduler-load.ts";

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const call = (owner: string, priority: Request["priority"]): Request => ({
  owner,
  priority,
  resource: { kind: "provider", account: "a".repeat(64) },
});
const reading = (owner: string, rank: number, continued = false) =>
  call(owner, reviewPriority("assess", continued, rank));

const readingsComplete = (run: Outcome) => {
  const readings = run.calls.filter((c) => c.reading);
  expect(readings).toHaveLength(FULL.readings);
  expect(readings.every((c) => c.ended !== undefined)).toBe(true);
};

// Why: starvation in either direction is the defect this lane removes.
test("300 readings beside four finders at 8 slots: turns never wait behind readings, readings keep their share and all finish", async () => {
  const run = await simulate({
    slots: 8,
    lingerMs: 2_000,
    reviews: [{ owner: "run-1", start: 0 }],
  });
  expect(run.jumped).toBe(0);
  expect(run.shareBroken).toBe(0);
  readingsComplete(run);
  const continuations = run.calls.filter((c) => c.kind === "find continuation");
  expect(continuations).toHaveLength(FULL.finders * (FULL.turns - 1));
  // A continuation whose lingering slot no other turn took is granted at the instant it asks. A
  // turn waiting when the finder released takes that slot at the same instant.
  for (const c of continuations) {
    const others = run.turnGrants.filter(
      (at) => at >= (c.previousRelease ?? 0) && at <= c.asked,
    ).length;
    if (others - (c.granted === c.asked ? 1 : 0) === 0)
      expect(c.granted).toBe(c.asked);
  }
});

// Why: the bound must hold without the linger.
test("with no linger a continuation waits only for the next slot no earlier turn takes", async () => {
  const run = await simulate({
    slots: 8,
    lingerMs: 0,
    reviews: [{ owner: "run-1", start: 0 }],
  });
  // No slot freed while a turn waited went to a reading beyond the readings' share.
  expect(run.jumped).toBe(0);
  expect(run.shareBroken).toBe(0);
  readingsComplete(run);
});

// Why: 12.37, one review's backlog must not block another's first step; its readings wait for its reserve.
test("a second owner's first call takes the next free slot, then the two owners share the slots", async () => {
  const budget = new Scheduler(8, 8, 8, undefined, Date.now, false, {
    lingerMs: 0,
  });
  const held = new Map<Grant, string>();
  const granted: string[] = [];
  const queue = (owner: string, request: Request) =>
    budget.admit(request).then((grant) => {
      held.set(grant, owner);
      granted.push(owner);
    });
  const release = async (owner: string) => {
    const grant = [...held].find(([, o]) => o === owner)?.[0];
    if (!grant) throw new Error(`${owner} holds no slot`);
    held.delete(grant);
    await grant.release();
    await flush();
  };
  for (let n = 0; n < 308; n++)
    void queue("run-a", reading("run-a", 1_000 - (n % 300)));
  await flush();
  // Four slots stay free for run-a's first steps until its first reading ends.
  expect(granted).toEqual(Array(4).fill("run-a"));
  await release("run-a");
  expect(granted).toEqual(Array(9).fill("run-a"));
  granted.length = 0;
  void queue("run-b", call("run-b", reviewPriority("frame", false)));
  for (let n = 0; n < 20; n++) void queue("run-b", reading("run-b", n));
  await release("run-a");
  expect(granted).toEqual(["run-b"]);
  for (let n = 0; n < 3; n++) await release("run-a");
  expect(granted).toEqual(Array(4).fill("run-b"));
  granted.length = 0;
  for (let n = 0; n < 3; n++) {
    await release("run-a");
    await release("run-b");
  }
  expect(granted).toEqual([
    "run-a",
    "run-b",
    "run-a",
    "run-b",
    "run-a",
    "run-b",
  ]);
  const owners = [...held.values()];
  expect(owners.filter((o) => o === "run-a")).toHaveLength(4);
  expect(owners.filter((o) => o === "run-b")).toHaveLength(4);
  for (const grant of held.keys()) await grant.release();
});

// Why: riskiest first is the product rule; readings may arrive at any time with any rank, and a
// started reading's follow-up keeps its conversation and the provider's prompt cache warm.
test("an owner's readings come out follow-ups first, then by rank, higher first, then by arrival", async () => {
  let now = 0;
  const budget = new Scheduler(8, 8, 1, undefined, () => now, false, {
    lingerMs: 0,
  });
  const first = await budget.admit(
    call("run-1", reviewPriority("find", false)),
  );
  const order: string[] = [];
  const queue = (name: string, rank: number, continued = false) =>
    budget.admit(reading("run-1", rank, continued)).then(async (grant) => {
      order.push(name);
      await flush();
      await grant.release();
    });
  const waiting = [
    queue("5 first", 5),
    queue("9 first", 9),
    queue("5 second", 5),
    queue("1", 1),
    queue("9 second", 9),
    queue("follow-up", 0, true),
  ];
  now = 1_000;
  await flush();
  await first.release();
  await flush();
  waiting.push(queue("7 late", 7));
  await Promise.all(waiting);
  expect(order).toEqual([
    "follow-up",
    "9 first",
    "9 second",
    "7 late",
    "5 first",
    "5 second",
    "1",
  ]);
});

// Why: the readings' share must never be the only slot, or a finder waits behind every reading.
test("at a limit of 1 with readings queued, a continuation takes the next free slot", async () => {
  const budget = new Scheduler(8, 8, 1, undefined, Date.now, false, {
    lingerMs: 0,
  });
  const held = await budget.admit(reading("run-1", 1));
  const order: string[] = [];
  const queue = (name: string, request: Request) =>
    budget.admit(request).then(async (grant) => {
      order.push(name);
      await flush();
      await grant.release();
    });
  const waiting = [
    ...Array.from({ length: 5 }, (_, n) =>
      queue(`reading ${n}`, reading("run-1", 10 + n)),
    ),
    queue("continuation", call("run-1", reviewPriority("find", true))),
  ];
  await flush();
  await held.release();
  await Promise.all(waiting);
  expect(order[0]).toBe("continuation");
  expect(order).toHaveLength(6);
});

const ACCOUNT = "a".repeat(64);
type Pending = { readonly run: () => void; readonly at: number };
/** Timers that fire only when the test moves `now` on. */
const manualClock = () => {
  const pending = new Set<Pending>();
  let now = 0;
  const timers: Timers = {
    set: (run, ms) => {
      const timer: Pending = { run, at: now + ms };
      pending.add(timer);
      return timer;
    },
    clear: (handle) => pending.delete(handle as Pending),
  };
  return {
    timers,
    now: () => now,
    advance: async (ms: number) => {
      now += ms;
      for (const timer of [...pending])
        if (timer.at <= now) {
          pending.delete(timer);
          timer.run();
        }
      await flush();
    },
  };
};
/** A scheduler at a fixed `limit`; calls are named, granted names are kept in order. */
const slots = (limit: number, options: SchedulerOptions = { lingerMs: 0 }) => {
  const clock = manualClock();
  const budget = new Scheduler(8, 8, limit, undefined, clock.now, false, {
    timers: clock.timers,
    ...options,
  });
  const granted: string[] = [];
  const grants = new Map<string, Grant>();
  return {
    budget,
    clock,
    granted,
    ask: (name: string, request: Request) =>
      void budget.admit(request).then((grant) => {
        grants.set(name, grant);
        granted.push(name);
      }),
    /** Ends `name`'s call, or the earliest granted call whose name starts with it. */
    end: async (name: string) => {
      const key = grants.has(name)
        ? name
        : [...grants.keys()].find((k) => k.startsWith(name));
      const grant = key === undefined ? undefined : grants.get(key);
      if (key === undefined || !grant) throw new Error(`${name} holds no slot`);
      grants.delete(key);
      await grant.release();
      await flush();
    },
    readings: async () => (await budget.observe()).readingsHeld,
    held: async () => (await budget.observe()).providerHeld,
    endAll: async () => {
      for (const grant of grants.values()) await grant.release();
    },
  };
};
const step = (
  owner: string,
  stage: "frame" | "map" | "find",
  continued = false,
) => call(owner, reviewPriority(stage, continued));
const queueReadings = (
  run: ReturnType<typeof slots>,
  owner: string,
  count: number,
) => {
  for (let n = 0; n < count; n++)
    run.ask(`${owner} reading ${n}`, reading(owner, count - n));
};

// Why: the readings now ask at 3 s; without this the chain waits most of a reading.
test("readings that ask first leave the reserve free, and Frame and Map asking after them are granted at once", async () => {
  const run = slots(8);
  const lease = await run.budget.activate(ACCOUNT, "run-1");
  queueReadings(run, "run-1", 20);
  await flush();
  expect(await run.readings()).toBe(4);
  run.ask("frame", step("run-1", "frame"));
  run.ask("map", step("run-1", "map"));
  await flush();
  expect(run.granted.slice(-2).sort()).toEqual(["frame", "map"]);
  expect(await run.readings()).toBe(4);
  expect(await run.held()).toBe(6);
  lease();
  await run.endAll();
});

// Why: the two orders must not differ.
test("readings first, then Frame and Map: when Frame ends before any reading, three finders' first turns are granted at once", async () => {
  const run = slots(8);
  const lease = await run.budget.activate(ACCOUNT, "run-1");
  queueReadings(run, "run-1", 20);
  await flush();
  run.ask("frame", step("run-1", "frame"));
  run.ask("map", step("run-1", "map"));
  await flush();
  await run.end("frame");
  expect(await run.readings()).toBe(4);
  for (let n = 0; n < 4; n++) run.ask(`finder ${n}`, step("run-1", "find"));
  await flush();
  expect(run.granted.filter((name) => name.startsWith("finder"))).toEqual([
    "finder 0",
    "finder 1",
    "finder 2",
  ]);
  lease();
  await run.endAll();
});

// Why: the reserve must not idle slots for a run with no steps.
test("a run that only has readings holds every slot once its first reading has ended", async () => {
  const run = slots(8);
  queueReadings(run, "run-1", 20);
  await flush();
  expect(await run.readings()).toBe(4);
  await run.end("run-1 reading");
  expect(await run.readings()).toBe(8);
  await run.end("run-1 reading");
  expect(await run.readings()).toBe(8);
  await run.endAll();
});

// Why: the burst the reserve is sized for.
test("with a lease and Map in flight readings leave three slots free, and three of four finders asking when Frame ends are granted at once", async () => {
  const run = slots(8);
  const lease = await run.budget.activate(ACCOUNT, "run-1");
  run.ask("frame", step("run-1", "frame"));
  run.ask("map", step("run-1", "map"));
  await flush();
  queueReadings(run, "run-1", 20);
  await flush();
  // Frame and Map hold two slots and keep two more.
  expect(await run.readings()).toBe(4);
  await run.end("frame");
  expect(await run.readings()).toBe(4);
  expect(await run.held()).toBe(5);
  for (let n = 0; n < 4; n++) run.ask(`finder ${n}`, step("run-1", "find"));
  await flush();
  expect(run.granted.filter((name) => name.startsWith("finder"))).toEqual([
    "finder 0",
    "finder 1",
    "finder 2",
  ]);
  await run.end("run-1 reading");
  expect(run.granted.at(-1)).toBe("finder 3");
  lease();
  await run.endAll();
});

// Why: a chat's turn must not cap a review's readings.
test("an owner without a lease reserves nothing while its turn is in flight", async () => {
  const run = slots(8);
  const lease = await run.budget.activate(ACCOUNT, "run-1");
  run.ask("chat turn", step("chat", "find"));
  await flush();
  queueReadings(run, "run-1", 20);
  await flush();
  await run.end("run-1 reading");
  expect(await run.readings()).toBe(7);
  expect(await run.held()).toBe(8);
  lease();
  await run.endAll();
});

// Why: no starvation either way was the first design's guarantee.
test("the readings' quarter survives the reserve", async () => {
  const run = slots(8);
  const lease = await run.budget.activate(ACCOUNT, "run-1");
  run.ask("frame", step("run-1", "frame"));
  for (let n = 0; n < 7; n++) run.ask(`chat ${n}`, step("chat", "find"));
  await flush();
  run.ask("chat waiting", step("chat", "find", true));
  queueReadings(run, "run-1", 3);
  await flush();
  // Frame's reserve is three slots, yet with both bands waiting a reading below its quarter goes first.
  await run.end("chat 0");
  expect(run.granted.at(-1)).toBe("run-1 reading 0");
  await run.end("chat 1");
  expect(run.granted.at(-1)).toBe("run-1 reading 1");
  await run.end("chat 2");
  expect(run.granted.at(-1)).toBe("chat waiting");
  lease();
  await run.endAll();
  // Three runs that have not started, and a review's Frame, ask for more than the limit less the quarter.
  for (const [limit, share] of [
    [1, 0],
    [2, 1],
    [4, 1],
  ] as const) {
    const small = slots(limit);
    const review = await small.budget.activate(ACCOUNT, "run-0");
    for (const owner of ["run-1", "run-2", "run-3"])
      queueReadings(small, owner, 5);
    await flush();
    // At 1 the reserve is nothing: half of one slot rounds down.
    expect(await small.readings()).toBe(Math.max(1, share));
    small.ask("frame", step("run-0", "frame"));
    await small.end("run-1 reading");
    expect(await small.readings()).toBeGreaterThanOrEqual(share);
    review();
    await small.endAll();
  }
});

// Why: steps follow each other with a commit between them.
test("when a review's only step in flight ends, its next steps asking inside the linger are granted at once", async () => {
  const run = slots(8, { lingerMs: 2_000 });
  const lease = await run.budget.activate(ACCOUNT, "run-1");
  run.ask("frame", step("run-1", "frame"));
  await flush();
  queueReadings(run, "run-1", 20);
  await flush();
  expect(await run.readings()).toBe(4);
  await run.end("frame");
  // The readings did not take the slots Frame and its reserve leave.
  expect(await run.readings()).toBe(4);
  await run.clock.advance(500);
  for (let n = 0; n < 4; n++) run.ask(`finder ${n}`, step("run-1", "find"));
  await flush();
  expect(run.granted.filter((name) => name.startsWith("finder"))).toHaveLength(
    4,
  );
  lease();
  await run.endAll();
});

// Why: the hold must end by itself.
test("after the linger with no new step, the readings take every slot with no other event", async () => {
  const run = slots(8, { lingerMs: 2_000 });
  const lease = await run.budget.activate(ACCOUNT, "run-1");
  run.ask("frame", step("run-1", "frame"));
  await flush();
  queueReadings(run, "run-1", 20);
  await flush();
  await run.end("frame");
  await run.clock.advance(1_999);
  expect(await run.readings()).toBe(4);
  await run.clock.advance(1);
  expect(await run.readings()).toBe(8);
  lease();
  await run.endAll();
});

// Why: a held review that still has an owner entry must keep its reserve once, not twice.
test("a review inside its hold with readings in flight keeps its reserve once", async () => {
  const run = slots(16, { lingerMs: 2_000 });
  const lease = await run.budget.activate(ACCOUNT, "run-1");
  run.ask("frame", step("run-1", "frame"));
  for (let n = 0; n < 4; n++) run.ask(`finder ${n}`, step("run-1", "find"));
  await flush();
  queueReadings(run, "run-1", 20);
  await flush();
  // Five steps in flight keep nothing, so the readings fill the other eleven slots.
  expect(await run.readings()).toBe(11);
  for (let n = 0; n < 4; n++) await run.end(`finder ${n}`);
  await run.clock.advance(1_500);
  await run.end("frame");
  // At 2 s the finders' lingering slots expire; Frame's and its hold of four remain.
  await run.clock.advance(500);
  // Eleven readings and a reserve of four leave room for one more; counted twice it would be eight.
  expect(await run.readings()).toBe(12);
  expect(await run.held()).toBe(12);
  lease();
  await run.endAll();
});

// Why: a lost wake-up would leave readings waiting beside free slots.
test("the hold's lapse wakes the queue when another owner's turn took the lingering slot first", async () => {
  const run = slots(8, { lingerMs: 2_000 });
  const lease = await run.budget.activate(ACCOUNT, "run-1");
  run.ask("frame", step("run-1", "frame"));
  await flush();
  queueReadings(run, "run-1", 20);
  await flush();
  await run.end("frame");
  await run.clock.advance(500);
  run.ask("chat turn", step("chat", "find"));
  await flush();
  expect(run.granted.at(-1)).toBe("chat turn");
  expect(await run.readings()).toBe(4);
  await run.clock.advance(1_500);
  expect(await run.readings()).toBe(7);
  expect(await run.held()).toBe(8);
  lease();
  await run.endAll();
});

// Why: the reserve must end by itself.
test("a closed lease ends the reserve at once, mid-step or during the hold", async () => {
  const closing = slots(8);
  const lease = await closing.budget.activate(ACCOUNT, "run-1");
  closing.ask("frame", step("run-1", "frame"));
  await flush();
  queueReadings(closing, "run-1", 20);
  await flush();
  expect(await closing.readings()).toBe(4);
  lease();
  await flush();
  expect(await closing.readings()).toBe(7);
  await closing.endAll();

  const holding = slots(8, { lingerMs: 2_000 });
  const second = await holding.budget.activate(ACCOUNT, "run-1");
  holding.ask("frame", step("run-1", "frame"));
  await flush();
  queueReadings(holding, "run-1", 20);
  await flush();
  await holding.end("frame");
  expect(await holding.readings()).toBe(4);
  second();
  await flush();
  // Only Frame's lingering slot is left.
  expect(await holding.readings()).toBe(7);
  await holding.endAll();
});
