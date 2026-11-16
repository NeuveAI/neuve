/**
 * A deterministic load run of the machine's model-call scheduler in virtual time: the real
 * `Scheduler` class, no model, no socket, seeded random numbers. It prints Markdown tables.
 *
 *   bun packages/harness/scripts/scheduler-load.ts           the full workload
 *   bun packages/harness/scripts/scheduler-load.ts --quick   a small workload that proves the script runs
 */
import { Heap } from "../src/budget/queue.ts";
import {
  LIMIT_CAUSE,
  Scheduler,
  TURN_LINGER_MS,
  type Numbers,
  type Priority,
  type Timers,
} from "../src/budget/scheduler.ts";
import { reviewPriority } from "../src/pi/priority.ts";

const ACCOUNT = "a".repeat(64);

type Event = {
  readonly at: number;
  readonly sequence: number;
  run: () => void;
};

/** Virtual time: events run in time order, each after every microtask the last one queued. */
export class VirtualClock {
  now = 0;
  private sequence = 0;
  private readonly events = new Heap<Event>(
    (a, b) => a.at - b.at || a.sequence - b.sequence,
  );
  /** Called after each event's microtasks have run. */
  onSettled: () => void = () => {};
  readonly read = () => this.now;
  readonly timers: Timers = {
    set: (run, ms) => this.at(this.now + ms, run),
    clear: (handle) => this.events.remove(handle as Event),
  };
  at(at: number, run: () => void): Event {
    const event = {
      at: Math.max(at, this.now),
      sequence: this.sequence++,
      run,
    };
    this.events.add(event);
    return event;
  }
  sleep(ms: number) {
    return new Promise<void>((resolve) => this.at(this.now + ms, resolve));
  }
  async run() {
    for (;;) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      this.onSettled();
      const event = this.events.peek();
      if (!event) return;
      this.events.remove(event);
      this.now = event.at;
      event.run();
    }
  }
}

/** Mulberry32: the same seed gives the same workload in every configuration. */
const random = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const between = (next: () => number, low: number, high: number) =>
  Math.round(low + (high - low) * next());

export interface WorkloadSize {
  readonly readings: number;
  readonly finders: number;
  readonly turns: number;
  readonly verifies: number;
}
export const FULL: WorkloadSize = {
  readings: 300,
  finders: 4,
  turns: 10,
  verifies: 5,
};
export const QUICK: WorkloadSize = {
  readings: 30,
  finders: 2,
  turns: 3,
  verifies: 2,
};

/** Every duration of one review, drawn up front so each configuration runs the same calls. */
export interface Plan {
  readonly frameMs: number;
  readonly mapMs: number;
  readonly finders: ReadonlyArray<{
    readonly turns: ReadonlyArray<{
      readonly ms: number;
      readonly gapMs: number;
    }>;
    readonly verifies: ReadonlyArray<number>;
  }>;
  readonly readings: ReadonlyArray<{
    readonly ms: number;
    readonly rank: number;
  }>;
}
export const plan = (size: WorkloadSize, seed = 1): Plan => {
  const next = random(seed);
  const ranks = Array.from({ length: size.readings }, (_, n) => n + 1);
  for (let n = ranks.length - 1; n > 0; n--) {
    const m = Math.floor(next() * (n + 1));
    [ranks[n], ranks[m]] = [ranks[m] ?? 0, ranks[n] ?? 0];
  }
  return {
    frameMs: between(next, 18_000, 22_000),
    mapMs: between(next, 36_000, 44_000),
    finders: Array.from({ length: size.finders }, () => ({
      turns: Array.from({ length: size.turns }, () => ({
        ms: between(next, 10_000, 30_000),
        gapMs: between(next, 200, 1_500),
      })),
      verifies: Array.from({ length: size.verifies }, () =>
        between(next, 4_000, 13_000),
      ),
    })),
    readings: ranks.map((rank) => ({
      ms: 3_000 + 21 * between(next, 500, 900),
      rank,
    })),
  };
};

export type Kind =
  | "frame"
  | "map"
  | "find first"
  | "find continuation"
  | "verify"
  | "assess/lane-review";
export const KINDS: ReadonlyArray<Kind> = [
  "frame",
  "map",
  "find first",
  "find continuation",
  "verify",
  "assess/lane-review",
];
export interface Call {
  readonly owner: string;
  readonly kind: Kind;
  readonly reading: boolean;
  readonly asked: number;
  granted?: number;
  ended?: number;
  /** For a continuation: when its finder's previous turn gave its slot back. */
  readonly previousRelease?: number;
  throttled?: number;
}
/** The synthetic provider: answers in about 1.4 s; throttles above `throttleAbove` calls in flight. */
export interface Provider {
  readonly throttleAbove?: number;
}
export interface Simulation {
  readonly slots?: number;
  readonly lingerMs?: number;
  /** The scheduler's `turnReserve`; its default unless set, 0 for none. */
  readonly turnReserve?: number;
  readonly reviews: ReadonlyArray<{
    readonly owner: string;
    readonly start: number;
  }>;
  readonly readings?: boolean;
  readonly size?: WorkloadSize;
  readonly provider?: Provider;
}
export interface Outcome {
  readonly calls: ReadonlyArray<Call>;
  /** A reading granted while a turn waited and readings already held their share. */
  readonly jumped: number;
  /** A settled moment when turns and readings both waited and readings held less than their share. */
  readonly shareBroken: number;
  /** Turn grant times, in order. */
  readonly turnGrants: ReadonlyArray<number>;
  readonly limits: ReadonlyArray<{
    readonly at: number;
    readonly limit: number;
    readonly change: number;
    readonly cause: number;
  }>;
  readonly end: number;
}

export async function simulate(input: Simulation): Promise<Outcome> {
  const clock = new VirtualClock();
  const limits: Array<Outcome["limits"][number]> = [];
  const scheduler = new Scheduler(
    8,
    8,
    input.slots,
    (event: Numbers) => {
      if (event.change && event.limit !== undefined)
        limits.push({
          at: clock.now,
          limit: event.limit,
          change: event.change,
          cause: event.cause ?? 0,
        });
    },
    clock.read,
    false,
    {
      lingerMs: input.lingerMs ?? TURN_LINGER_MS,
      timers: clock.timers,
      ...(input.turnReserve === undefined
        ? {}
        : { turnReserve: input.turnReserve }),
    },
  );
  const size = input.size ?? FULL;
  const work = plan(size);
  const answers = random(7);
  const calls: Call[] = [];
  const waitingTurns = new Set<Call>();
  const waitingReadings = new Set<Call>();
  const turnGrants: number[] = [];
  let readingsHeld = 0,
    inFlight = 0,
    jumped = 0,
    shareBroken = 0;
  const share = () => {
    const limit = limits.at(-1)?.limit ?? input.slots ?? 8;
    return Math.min(limit - 1, Math.max(1, Math.floor(limit / 4)));
  };
  clock.onSettled = () => {
    if (waitingTurns.size && waitingReadings.size && readingsHeld < share())
      shareBroken++;
  };

  const call = async (
    owner: string,
    kind: Kind,
    priority: Priority,
    ms: number,
    previousRelease?: number,
  ): Promise<number> => {
    const reading = priority.reading !== undefined;
    for (;;) {
      const record: Call = {
        owner,
        kind,
        reading,
        asked: clock.now,
        ...(previousRelease === undefined ? {} : { previousRelease }),
      };
      calls.push(record);
      (reading ? waitingReadings : waitingTurns).add(record);
      const grant = await scheduler.admit({
        owner,
        priority,
        resource: { kind: "provider", account: ACCOUNT },
      });
      (reading ? waitingReadings : waitingTurns).delete(record);
      record.granted = clock.now;
      if (reading) {
        if (waitingTurns.size && readingsHeld >= share()) jumped++;
        readingsHeld++;
      } else turnGrants.push(clock.now);
      inFlight++;
      const throttle =
        input.provider?.throttleAbove !== undefined &&
        inFlight > input.provider.throttleAbove;
      if (throttle) {
        await clock.sleep(500);
        await scheduler.throttle(ACCOUNT, false, true);
        record.throttled = clock.now;
      } else await clock.sleep(ms);
      inFlight--;
      if (reading) readingsHeld--;
      record.ended = clock.now;
      // Time to answer: about 1.4 s whatever the call's length; a 429 never answers.
      const answer = 1_400 * Math.exp(0.25 * (answers() + answers() - 1));
      await grant.release({
        durationMs: clock.now - (record.granted ?? clock.now),
        throttled: false,
        retryAfter: false,
        ...(throttle ? {} : { firstTokenMs: answer }),
      });
      if (!throttle) return clock.now;
      await clock.sleep(2_000);
    }
  };

  const review = async (owner: string, start: number) => {
    await clock.sleep(start);
    // A review attempt opens its lease before its first model call and holds it to the end.
    const lease = await scheduler.activate(ACCOUNT, owner);
    const readings =
      input.readings === false
        ? []
        : work.readings.map((r, n) =>
            call(
              owner,
              "assess/lane-review",
              reviewPriority(n % 2 ? "lane-review" : "assess", false, r.rank),
              r.ms,
            ),
          );
    await Promise.all([
      call(owner, "frame", reviewPriority("frame", false), work.frameMs),
      call(owner, "map", reviewPriority("map", false), work.mapMs),
    ]);
    const finders = work.finders.map(async (finder) => {
      let released: number | undefined;
      for (const [n, turn] of finder.turns.entries()) {
        if (released !== undefined) await clock.sleep(turn.gapMs);
        released = await call(
          owner,
          n ? "find continuation" : "find first",
          reviewPriority("find", n > 0),
          turn.ms,
          n ? released : undefined,
        );
      }
      await Promise.all(
        finder.verifies.map((ms) =>
          call(owner, "verify", reviewPriority("verify", false), ms),
        ),
      );
    });
    await Promise.all([...readings, ...finders]);
    lease();
  };
  const done = Promise.all(input.reviews.map((r) => review(r.owner, r.start)));
  await clock.run();
  const stuck = calls.filter((c) => c.ended === undefined).length;
  if (stuck) throw new Error(`${stuck} calls never ended`);
  await done;
  return {
    calls,
    jumped,
    shareBroken,
    turnGrants,
    limits,
    end: Math.max(0, ...calls.map((c) => c.ended ?? 0)),
  };
}

/** Readings' call lengths by effort: an Assess call, then each of two Lane review calls. */
const EFFORTS = {
  medium: { assessMs: 30_000, laneMs: 9_500 },
  high: { assessMs: 82_000, laneMs: 18_000 },
} as const;
export type Effort = keyof typeof EFFORTS;
/** When the readings ask, and the cut-off by which a group of readings counts as read. */
const READINGS_AT = 3_000;
const CUTOFF_MS = 557_000;
export interface EarlyStart {
  readonly slots: number;
  readonly turnReserve?: number;
  /** When Frame and Map ask. */
  readonly frameAt: number;
  /** The readings' effort; none without one. */
  readonly effort?: Effort;
  readonly groups: number;
  readonly size: WorkloadSize;
}
export interface EarlyCall {
  readonly kind: Kind;
  readonly reading: boolean;
  readonly asked: number;
  readonly granted: number;
  readonly ended: number;
}
export interface EarlyOutcome {
  readonly calls: ReadonlyArray<EarlyCall>;
  /** When each group of readings ended. */
  readonly groups: ReadonlyArray<number>;
  /** Free slots times milliseconds while a reading waited. */
  readonly idleMs: number;
}

/**
 * A review whose readings ask at 3 s, as they now do: groups of one Assess call and then two Lane
 * review calls, which ask once Frame and Map have ended, each call ±30% of its effort's length.
 * Frame and Map ask at `frameAt`; the finders start when Frame ends.
 */
export async function earlyStart(input: EarlyStart): Promise<EarlyOutcome> {
  const clock = new VirtualClock();
  const scheduler = new Scheduler(
    8,
    8,
    input.slots,
    () => {},
    clock.read,
    false,
    {
      timers: clock.timers,
      ...(input.turnReserve === undefined
        ? {}
        : { turnReserve: input.turnReserve }),
    },
  );
  const next = random(1);
  const around = () => 0.7 + 0.6 * next();
  const frameMs = between(next, 18_000, 22_000),
    mapMs = between(next, 36_000, 44_000);
  const finders = Array.from({ length: input.size.finders }, () => ({
    turns: Array.from({ length: input.size.turns }, () => ({
      ms: between(next, 10_000, 30_000),
      gapMs: between(next, 200, 1_500),
    })),
    verifies: Array.from({ length: input.size.verifies }, () =>
      between(next, 4_000, 13_000),
    ),
  }));
  const groups = Array.from({ length: input.groups }, (_, n) => ({
    rank: input.groups - n,
    assess: around(),
    lanes: [around(), around()] as const,
  }));
  const calls: EarlyCall[] = [];
  let pending = 0,
    held = 0,
    readingsWaiting = 0,
    idleMs = 0,
    last = 0;
  const tick = () => {
    if (readingsWaiting) idleMs += (input.slots - held) * (clock.now - last);
    last = clock.now;
  };
  const call = async (kind: Kind, priority: Priority, ms: number) => {
    const reading = priority.reading !== undefined;
    pending++;
    tick();
    if (reading) readingsWaiting++;
    const asked = clock.now;
    const grant = await scheduler.admit({
      owner: "run-1",
      priority,
      resource: { kind: "provider", account: ACCOUNT },
    });
    tick();
    if (reading) readingsWaiting--;
    held++;
    const granted = clock.now;
    await clock.sleep(Math.round(ms));
    tick();
    held--;
    pending--;
    calls.push({ kind, reading, asked, granted, ended: clock.now });
    await grant.release({
      durationMs: clock.now - granted,
      throttled: false,
      retryAfter: false,
      firstTokenMs: 1_400,
    });
  };
  const lease = await scheduler.activate(ACCOUNT, "run-1");
  let frontEnded = () => {};
  const front = new Promise<void>((resolve) => (frontEnded = resolve));
  const steps = (async () => {
    await clock.sleep(input.frameAt);
    const map = call("map", reviewPriority("map", false), mapMs);
    await call("frame", reviewPriority("frame", false), frameMs);
    void map.then(frontEnded);
    await Promise.all(
      finders.map(async (finder) => {
        for (const [n, turn] of finder.turns.entries()) {
          if (n) await clock.sleep(turn.gapMs);
          await call(
            n ? "find continuation" : "find first",
            reviewPriority("find", n > 0),
            turn.ms,
          );
        }
        await Promise.all(
          finder.verifies.map((ms) =>
            call("verify", reviewPriority("verify", false), ms),
          ),
        );
      }),
    );
    await map;
  })();
  const ended: number[] = [];
  const efforts =
    input.effort === undefined ? undefined : EFFORTS[input.effort];
  const readings = (async () => {
    if (!efforts) return;
    await clock.sleep(READINGS_AT);
    await Promise.all(
      groups.map(async (group) => {
        await call(
          "assess/lane-review",
          reviewPriority("assess", false, group.rank),
          group.assess * efforts.assessMs,
        );
        await front;
        for (const [n, length] of group.lanes.entries())
          await call(
            "assess/lane-review",
            reviewPriority("lane-review", n > 0, group.rank),
            length * efforts.laneMs,
          );
        ended.push(clock.now);
      }),
    );
  })();
  const done = Promise.all([steps, readings]).then(() => lease());
  await clock.run();
  if (pending) throw new Error(`${pending} calls never ended`);
  await done;
  return { calls, groups: ended, idleMs };
}

const seconds = (ms: number | undefined) =>
  ms === undefined ? "–" : (ms / 1_000).toFixed(1);
const quantile = (values: number[], q: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * q) - 1)];
};
const waits = (calls: ReadonlyArray<Call>) =>
  calls.map((c) => (c.granted ?? c.asked) - c.asked);
type Ended = Pick<Call, "kind" | "reading" | "ended">;
const lastEnd = (calls: ReadonlyArray<Ended>) =>
  Math.max(0, ...calls.map((c) => c.ended ?? 0));
const findersEnd = (calls: ReadonlyArray<Ended>) =>
  lastEnd(calls.filter((c) => c.kind.startsWith("find")));
const readingsEnd = (calls: ReadonlyArray<Ended>) =>
  lastEnd(calls.filter((c) => c.reading));
/** When the chain ends: the last Frame, Map, finder turn or Verify. */
const turnsEnd = (calls: ReadonlyArray<Ended>) =>
  lastEnd(calls.filter((c) => !c.reading));
const waitRow = (prefix: string, kind: Kind, calls: ReadonlyArray<Call>) => {
  const of = calls.filter((c) => c.kind === kind),
    w = waits(of);
  return `| ${prefix} | ${kind} | ${of.length} | ${seconds(quantile(w, 0.5))} | ${seconds(quantile(w, 0.9))} | ${seconds(w.length ? Math.max(...w) : undefined)} |`;
};

async function main(quick: boolean) {
  const size = quick ? QUICK : FULL;
  const slotCounts = quick ? [8] : [8, 16, 32];
  const lingers = [0, TURN_LINGER_MS];
  const one = [{ owner: "run-1", start: 0 }];
  const out: string[] = [];
  const started = performance.now();
  out.push(
    `# Scheduler load run${quick ? " (quick)" : ""}`,
    "",
    `One review: Frame and Map at the start, ${size.finders} finders of ${size.turns} turns (10–30 s, tool gaps 0.2–1.5 s), ${size.verifies} Verify calls per finder (4–13 s), ${size.readings} readings queued at the start (3 s + 21 ms per token, 500–900 tokens). Waits in seconds of virtual time.`,
    "",
    "## Slot waits, one review, fixed slots",
    "",
    "| slots, linger | stage | calls | median | p90 | max |",
    "| --- | --- | ---: | ---: | ---: | ---: |",
  );
  const summary: string[] = [];
  for (const slots of slotCounts)
    for (const lingerMs of lingers) {
      const run = await simulate({ slots, lingerMs, reviews: one, size });
      const alone = await simulate({
        slots,
        lingerMs,
        reviews: one,
        size,
        readings: false,
      });
      for (const kind of KINDS)
        out.push(waitRow(`${slots}, ${lingerMs} ms`, kind, run.calls));
      summary.push(
        `| ${slots} | ${lingerMs} ms | ${seconds(findersEnd(run.calls))} | ${seconds(turnsEnd(run.calls))} | ${seconds(turnsEnd(alone.calls))} | ${seconds(readingsEnd(run.calls))} | ${seconds(run.end)} | ${seconds(alone.end)} | ${run.jumped} | ${run.shareBroken} |`,
      );
    }
  out.push(
    "",
    "## When the work ends, one review",
    "",
    "Times in seconds. Turns end: when the last Frame, Map, finder turn or Verify ends. Jumped: readings granted while a turn waited and readings already held their share. Share broken: moments when both waited and readings held less than a quarter of the slots.",
    "",
    "| slots | linger | finders end | turns end | turns end without readings | last reading ends | run ends | run ends without readings | jumped | share broken |",
    "| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...summary,
  );

  out.push(
    "",
    "## Two reviews, the second starting 60 s after the first",
    "",
    `Linger ${TURN_LINGER_MS} ms.`,
    "",
    "| slots, review | stage | calls | median | p90 | max |",
    "| --- | --- | ---: | ---: | ---: | ---: |",
  );
  const twoEnds: string[] = [];
  for (const slots of slotCounts) {
    const run = await simulate({
      slots,
      reviews: [
        { owner: "run-1", start: 0 },
        { owner: "run-2", start: 60_000 },
      ],
      size,
    });
    for (const owner of ["run-1", "run-2"]) {
      const mine = run.calls.filter((c) => c.owner === owner);
      for (const kind of KINDS)
        out.push(waitRow(`${slots}, ${owner}`, kind, mine));
      twoEnds.push(
        `| ${slots} | ${owner} | ${seconds(findersEnd(mine))} | ${seconds(turnsEnd(mine))} | ${seconds(readingsEnd(mine))} | ${seconds(lastEnd(mine))} |`,
      );
    }
  }
  out.push(
    "",
    "| slots | review | finders end | turns end | last reading ends | review ends |",
    "| ---: | --- | ---: | ---: | ---: | ---: |",
    ...twoEnds,
  );

  const causeName = new Map<number, string>(
    Object.entries(LIMIT_CAUSE).map(([name, code]) => [code, name]),
  );
  out.push(
    "",
    "## The adaptive limiter",
    "",
    "A synthetic provider answers in about 1.4 s (median). Throttling: it answers 429 after 0.5 s whenever more than 20 calls are in flight; the call retries 2 s later. Mixed lengths: it never throttles, and calls run 4 s to 44 s.",
    "",
    "| provider | reaches 16 | first cut | climb | step | throttled | retry-after | slowing | 429s | lowest after a cut | run ends |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  );
  const histories: string[] = [];
  for (const [name, provider] of [
    ["throttles above 20", { throttleAbove: 20 }],
    ["mixed lengths, no throttling", {}],
  ] as const) {
    const run = await simulate({ reviews: one, size, provider });
    const count = (cause: number) =>
      run.limits.filter((l) => l.cause === cause).length;
    const firstCut = run.limits.find((l) => l.change < 0);
    const afterCut = firstCut
      ? Math.min(
          ...run.limits.filter((l) => l.at >= firstCut.at).map((l) => l.limit),
        )
      : undefined;
    out.push(
      `| ${name} | ${seconds(run.limits.find((l) => l.limit >= 16)?.at)} | ${seconds(firstCut?.at)} | ${count(LIMIT_CAUSE.climb)} | ${count(LIMIT_CAUSE.step)} | ${count(LIMIT_CAUSE.throttled)} | ${count(LIMIT_CAUSE.retryAfter)} | ${count(LIMIT_CAUSE.slowing)} | ${run.calls.filter((c) => c.throttled !== undefined).length} | ${afterCut ?? "–"} | ${seconds(run.end)} |`,
    );
    histories.push(
      "",
      `Limit over time, ${name}: 8 at 0 s, then ${run.limits.map((l) => `${l.limit} at ${seconds(l.at)} s (${causeName.get(l.cause) ?? "?"})`).join(", ") || "no change"}.`,
    );
  }
  out.push(...histories);

  const groupCount = quick ? 6 : 67;
  out.push(
    "",
    "## Readings that start at 3 s",
    "",
    `One review with its lease. Frame and Map ask at 1.1 s (before the readings) or at 4.3 s (after them); ${size.finders} finders of ${size.turns} turns (10–30 s, tool gaps 0.2–1.5 s) start when Frame ends, then ${size.verifies} Verify calls each (4–13 s). ${groupCount} groups of readings ask at 3 s: one Assess call (30 s at medium effort, 82 s at high), then, once Frame and Map have ended, two Lane review calls (9.5 s or 18 s), each ±30%. Reserve on: the scheduler's default; off: \`turnReserve: 0\`. Waits and times in seconds; a pair is the longest, then the sum. Idle: free slots times seconds while a reading waited.`,
    "",
    "| slots | readings | Frame and Map ask | reserve | Frame waits | Map waits | first turns wait | later turns wait | Verify waits | finders end | steps end | last group ends | groups ended by 557 s | slot-seconds idle |",
    "| ---: | --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  );
  const pair = (calls: ReadonlyArray<EarlyCall>) => {
    const w = calls.map((c) => c.granted - c.asked);
    return `${seconds(Math.max(0, ...w))}, ${seconds(w.reduce((a, b) => a + b, 0))}`;
  };
  const earlyRow = async (
    slots: number,
    frameAt: number,
    effort: Effort | undefined,
    reserve: boolean,
  ) => {
    const run = await earlyStart({
      slots,
      frameAt,
      groups: groupCount,
      size,
      ...(effort ? { effort } : {}),
      ...(reserve ? {} : { turnReserve: 0 }),
    });
    const of = (kind: Kind) => run.calls.filter((c) => c.kind === kind);
    const wait = (kind: Kind) => {
      const first = of(kind)[0];
      return seconds(first && first.granted - first.asked);
    };
    out.push(
      `| ${slots} | ${effort ?? "none"} | ${seconds(frameAt)} | ${reserve ? "on" : "off"} | ${wait("frame")} | ${wait("map")} | ${pair(of("find first"))} | ${pair(of("find continuation"))} | ${pair(of("verify"))} | ${seconds(findersEnd(run.calls))} | ${seconds(turnsEnd(run.calls))} | ${effort ? seconds(Math.max(0, ...run.groups)) : "–"} | ${effort ? `${run.groups.filter((at) => at <= CUTOFF_MS).length} of ${groupCount}` : "–"} | ${effort ? Math.round(run.idleMs / 1_000) : "–"} |`,
    );
  };
  for (const slots of quick ? [8] : [8, 16]) {
    await earlyRow(slots, 1_100, undefined, true);
    for (const effort of quick
      ? (["medium"] as const)
      : (["medium", "high"] as const))
      for (const frameAt of quick ? [4_300] : [1_100, 4_300])
        for (const reserve of [false, true])
          await earlyRow(slots, frameAt, effort, reserve);
  }

  out.push(
    "",
    `Simulated in ${((performance.now() - started) / 1_000).toFixed(1)} s of wall time.`,
  );
  console.log(out.join("\n"));
}

if (import.meta.main) await main(Bun.argv.includes("--quick"));
