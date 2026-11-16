import { createHash } from "node:crypto";
import { Heap } from "./queue.ts";
import { z } from "zod";

/** The longest owner a request or a lease carries: `Request` and the socket's `active` cap it. */
const OWNER_LENGTH = 128;
/**
 * The owner a budget sees. Up to 128 characters it is the owner itself, so every owner that fits
 * is unchanged in requests, leases and telemetry. A longer one, such as a deep repository path,
 * becomes `…`, its last 40 code points (the folder stays readable), `#` and the first 32 hex digits
 * of the SHA-256 of the whole owner. That is at most 114 characters, so a short form maps to itself;
 * it depends on the owner alone, so every client and host build names one owner alike; and two long
 * owners share it only if 128 bits of their hashes collide. Applied where a request or a lease
 * enters a budget, so a lease and its calls stay one owner and no caller shortens anything.
 */
export const budgetOwner = (owner: string) => {
  if (owner.length <= OWNER_LENGTH) return owner;
  const tail = Array.from(owner).slice(-40).join(""),
    hash = createHash("sha256").update(owner).digest("hex").slice(0, 32);
  return `…${tail}#${hash}`;
};

export const Priority = z.strictObject({
  class: z
    .enum(["interactive", "preparation", "speculation"])
    .default("interactive"),
  position: z
    .enum(["understand", "continuation", "started", "new"])
    .default("new"),
  stage: z.number().int().min(0).max(100).default(0),
  /** Present on a reading (Assess, Lane review); `rank` is its owner's risk rank, higher first. */
  reading: z
    .strictObject({ rank: z.number().int().min(0).max(1_000_000) })
    .optional(),
});
export type Priority = z.infer<typeof Priority>;
export const Request = z.strictObject({
  queuedAt: z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER)
    .optional(),
  owner: z.string().min(1).max(OWNER_LENGTH),
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
export type Request = z.infer<typeof Request>;
export const Observation = z.strictObject({
  durationMs: z.number().min(0).max(86_400_000),
  // Time to answer: from the call's start under its slot to the stream's first event that is not
  // an error. The wire key keeps its older name: an older host only reports its median, and a new
  // key would make a strict older host refuse the release and lose the sample.
  firstTokenMs: z.number().min(0).max(86_400_000).optional(),
  throttled: z.boolean().default(false),
  retryAfter: z.boolean().default(false),
});
export type Observation = z.infer<typeof Observation>;
export class BackgroundYield extends Error {
  constructor() {
    super("Background admission yielded");
    this.name = "BackgroundYield";
  }
}
export type Numbers = Record<string, number>;
export interface Grant {
  readonly permits: number;
  readonly floor?: boolean;
  readonly numbers?: Numbers;
  readonly signal?: AbortSignal;
  readonly descriptor?: number;
  release(observation?: Observation): void | Promise<void>;
}
export type ReviewLease = (() => void) & { readonly signal?: AbortSignal };
export interface Budget {
  admit(request: Request, signal?: AbortSignal): Promise<Grant>;
  throttle(
    account: string,
    retryAfter?: boolean,
    throttled?: boolean,
  ): Promise<void>;
  activate?(account: string, owner: string): Promise<ReviewLease>;
  measure?(account: string): Promise<Numbers>;
  capacity(): Promise<Numbers>;
  observe(): Promise<Numbers>;
}
const percentile = (values: number[], fraction: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
};

/** Each limiter decision carries its cause as this number, beside `limit` and `change`. */
export const LIMIT_CAUSE = {
  climb: 1,
  step: 2,
  throttled: 3,
  retryAfter: 4,
  slowing: 5,
} as const;
export type LimitCause = keyof typeof LIMIT_CAUSE;
/** The provider numbers that count each cause's decisions over the limiter's life. */
export const LIMIT_CAUSE_COUNT = {
  climb: "limitClimb",
  step: "limitStep",
  throttled: "limitThrottled",
  retryAfter: "limitRetryAfter",
  slowing: "limitSlowing",
} as const satisfies Record<LimitCause, string>;
const causes = Object.keys(LIMIT_CAUSE) as LimitCause[];

/**
 * One provider account's limit on model calls in flight: 8 to start, never outside 4..32. A
 * window closes after 20 completed calls or 30 s. Throttling (a 429 or a Retry-After header) cuts
 * to 70% at once, once per window. A window with at least 5 answer samples is judged by its median
 * time to answer against a baseline, the running average of earlier judged windows' medians; a
 * thinner window decides nothing. A median at least twice the baseline makes a slow window. One
 * slow window only holds, and leaves the baseline alone: one window's median is noisy, and local
 * work before a request can double it. A second slow window in a row cuts once ("slowing"), and
 * from then the baseline takes in the run's slow medians in order, so a level that stays high
 * becomes the new normal; the first judged window that is not slow ends the run. Under 1.5 times
 * the baseline a window is clean. A clean window that used the whole limit, with a known baseline
 * and no throttle or cut, raises it: by half until the limiter's first cut, by one after. Growing by
 * one slot a window would take about 160 completions to go from 8 to 16; overshooting costs a 429
 * on a retried call, and that cut is immediate. Whole-stream duration is reported and decides
 * nothing; it tracks output length.
 */
export class ProviderLimit {
  limit: number;
  /** When this limiter began, so a client can tell its decisions from a replaced host's. */
  readonly since: number;
  private baseline: number | undefined;
  /** The current run of slow windows: how many, and the medians the baseline has not taken in. */
  private slow = 0;
  private heldBack: number[] = [];
  private samples: Observation[] = [];
  private began: number;
  private throttles = 0;
  private retryHeaders = 0;
  private congestedWindow = false;
  private cutWindow = false;
  private everCut = false;
  private peak = 0;
  private readonly counts: Record<LimitCause, number> = {
    climb: 0,
    step: 0,
    throttled: 0,
    retryAfter: 0,
    slowing: 0,
  };
  constructor(
    readonly fixed: number | undefined,
    private readonly emit: (numbers: Numbers) => void = () => {},
    private readonly now = Date.now,
  ) {
    this.limit = fixed ?? 8;
    this.began = this.since = now();
    emit({
      limit: this.limit,
      change: 0,
      limiterSince: this.since,
      ...this.totals(),
    });
  }
  record(sample: Observation) {
    this.samples.push(sample);
    if (sample.throttled || sample.retryAfter) {
      this.congestedWindow = true;
      this.cut(sample.throttled ? "throttled" : "retryAfter");
    }
    if (this.samples.length < 20 && this.now() - this.began < 30_000) return;
    const durations = this.samples.map((s) => s.durationMs);
    const answers = this.samples.flatMap((s) =>
      s.firstTokenMs === undefined ? [] : [s.firstTokenMs],
    );
    const answerMs = percentile(answers, 0.5);
    this.emit({
      completedPerMinute:
        (this.samples.length * 60_000) / Math.max(1, this.now() - this.began),
      medianMs: percentile(durations, 0.5),
      slowestTenthMs: percentile(durations, 0.9),
      ...(answers.length ? { answerMs } : {}),
      answerSamples: answers.length,
      throttleShare: Math.min(
        1,
        (this.samples.filter((s) => s.throttled).length + this.throttles) /
          this.samples.length,
      ),
      retryAfterShare: Math.min(
        1,
        (this.samples.filter((s) => s.retryAfter).length + this.retryHeaders) /
          this.samples.length,
      ),
      limit: this.limit,
    });
    if (answers.length >= 5) {
      const answered = Math.max(1, answerMs);
      if (this.baseline === undefined) this.baseline = answered;
      else if (answerMs >= 2 * this.baseline) {
        this.slow++;
        this.heldBack.push(answered);
        if (this.slow >= 2) {
          if (this.slow === 2) this.cut("slowing");
          for (const median of this.heldBack)
            this.baseline = 0.8 * this.baseline + 0.2 * median;
          this.heldBack = [];
        }
      } else {
        this.slow = 0;
        this.heldBack = [];
        if (
          answerMs < 1.5 * this.baseline &&
          this.peak >= this.limit &&
          !this.congestedWindow &&
          !this.cutWindow
        )
          this.raise();
        this.baseline = 0.8 * this.baseline + 0.2 * answered;
      }
    }
    this.peak = 0;
    this.cutWindow = false;
    this.congestedWindow = false;
    this.throttles = 0;
    this.retryHeaders = 0;
    this.samples = [];
    this.began = this.now();
  }
  congested(retryAfter = false, throttled = true) {
    this.congestedWindow = true;
    if (throttled) this.throttles++;
    if (retryAfter) this.retryHeaders++;
    this.cut(throttled ? "throttled" : "retryAfter");
  }
  used(inFlight: number) {
    this.peak = Math.max(this.peak, inFlight);
  }
  private totals(): Numbers {
    return Object.fromEntries(
      causes.map((cause) => [LIMIT_CAUSE_COUNT[cause], this.counts[cause]]),
    );
  }
  private raise() {
    if (this.fixed !== undefined) return;
    if (this.everCut) this.change(Math.min(32, this.limit + 1), "step");
    else this.change(Math.min(32, Math.ceil(this.limit * 1.5)), "climb");
  }
  private cut(cause: LimitCause) {
    if (this.fixed === undefined && !this.cutWindow) {
      this.cutWindow = true;
      this.everCut = true;
      this.change(Math.max(4, Math.floor(this.limit * 0.7)), cause);
    }
  }
  private change(next: number, cause: LimitCause) {
    const change = next - this.limit;
    if (!change) return;
    this.limit = next;
    this.counts[cause]++;
    this.emit({
      limit: next,
      change,
      cause: LIMIT_CAUSE[cause],
      ...this.totals(),
    });
  }
}
type Waiter = {
  request: Request;
  at: number;
  sequence: number;
  admit: (grant: Grant) => void;
  refuse: (cause: Error) => void;
  cleanup: () => void;
};
const rank = (w: Waiter) =>
  ["understand", "continuation", "started", "new"].indexOf(
    w.request.priority.position,
  ) *
    100 -
  w.request.priority.stage +
  w.at / 100;
const byRank = (a: Waiter, b: Waiter) =>
  rank(a) - rank(b) || a.sequence - b.sequence;
const byArrival = (a: Waiter, b: Waiter) =>
  a.at - b.at || a.sequence - b.sequence;
const started = (w: Waiter) =>
  w.request.priority.position === "continuation" ? 0 : 1;
const byRisk = (a: Waiter, b: Waiter) =>
  started(a) - started(b) ||
  (b.request.priority.reading?.rank ?? 0) -
    (a.request.priority.reading?.rank ?? 0) ||
  byArrival(a, b);
const isReading = (w: Waiter) => w.request.priority.reading !== undefined;
const isBackground = (w: Waiter) => w.request.priority.class !== "interactive";
/** Speculation passes preparation only once it has waited 30 s and outranks it. */
const nextBackground = (
  preparation: Heap<Waiter>,
  speculation: Heap<Waiter>,
  now: number,
) => {
  const a = preparation.peek(),
    b = speculation.peek();
  if (!a) return b;
  if (!b) return a;
  return now - b.at >= 30_000 && rank(b) < rank(a) ? b : a;
};
class Waiting {
  readonly interactive = new Heap<Waiter>(byRank);
  readonly preparation = new Heap<Waiter>(byRank);
  readonly speculation = new Heap<Waiter>(byRank);
  get size() {
    return (
      this.interactive.size + this.preparation.size + this.speculation.size
    );
  }
  add(w: Waiter) {
    this[w.request.priority.class].add(w);
  }
  remove(w: Waiter) {
    this[w.request.priority.class].remove(w);
  }
  background(now: number) {
    return nextBackground(this.preparation, this.speculation, now);
  }
  next(now: number) {
    return this.interactive.peek() ?? this.background(now);
  }
}

/** How long a slot an interactive turn released is kept from readings, for that chain's next turn. */
export const TURN_LINGER_MS = 2_000;
/**
 * The free slots readings leave for a run's steps still to be scheduled, less the steps it holds:
 * Map and the first turns of three finders beside the slot Frame gives back. Never above half the
 * limit.
 */
export const TURN_RESERVE = 4;
export interface Timers {
  readonly set: (run: () => void, ms: number) => unknown;
  readonly clear: (handle: unknown) => void;
}
const systemTimers: Timers = {
  set: (run, ms) => setTimeout(run, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};
export interface SchedulerOptions {
  /** `TURN_LINGER_MS` unless set; 0 keeps no released slot from readings. */
  readonly lingerMs?: number;
  /** The linger timer's clock, beside the constructor's `now`. */
  readonly timers?: Timers;
  /** `TURN_RESERVE` unless set; 0 keeps no slot from readings for a review's steps. */
  readonly turnReserve?: number;
}
type Owner = {
  readonly turns: Heap<Waiter>;
  readonly readings: Heap<Waiter>;
  inFlight: number;
  turnsInFlight: number;
  /** Since this entry was created, a turn has been granted or a reading has ended. */
  started: boolean;
};

/**
 * Interactive model calls wait in two bands. Turns are the calls a review's chain waits on: Frame,
 * Map, each finder turn and Verify. Readings are the Assess and Lane review calls. A free slot
 * goes to a waiting turn first, so no number of queued readings delays a continuation or a Verify
 * beyond the next slot to free. When only readings wait, they leave free the larger of two counts.
 * One is the slots turns released in the last `TURN_LINGER_MS`, so a finder that comes straight
 * back from its tools finds one. The other is the reserve for steps still to be scheduled: the sum
 * over owners of what each keeps, at most the limit less the readings' quarter. Two kinds of owner
 * keep `min(TURN_RESERVE, half the limit)` less their turns in flight: a review (an owner with a
 * live lease from `Scheduler.activate` on this account) with a turn in flight or whose last turn in
 * flight ended within `TURN_LINGER_MS`, so its next step finds the slots; and an owner that has not
 * started (no turn granted and no reading ended since its entry was created) with a reading waiting
 * or in flight, so its Frame, Map and first finders do. Any other owner keeps nothing. The reserve
 * ends by itself: a turn granted, a turn released, a reading ended, a waiting reading withdrawn and
 * a lease closed each drain the queue, and the linger timer wakes it at the earliest lingering
 * slot's or hold's expiry while readings are held back. Readings take every other free
 * slot, and whenever one is waiting they are guaranteed a quarter of the limit, at least one slot
 * and never the only one, so turns cannot starve them nor they the turns. Within a band the next
 * call comes from the owner (a run) with the fewest calls in flight on this account, so two runs
 * share the slots whatever their backlogs. An owner's turns keep the earlier order (position, then
 * stage, with 100 ms of waiting worth one point); its readings go follow-up turns of started
 * readings first (their conversation and prompt cache are warm), then by risk rank, higher first,
 * then by arrival. Readings may arrive at any time and ranks need not be dense; ranks are compared
 * only within one owner, and different owners' readings by arrival. Preparation and speculation
 * come after all interactive work, and an active review still reserves one slot from them (the
 * scheduler's drain).
 */
class ProviderQueue {
  readonly preparation = new Heap<Waiter>(byRank);
  readonly speculation = new Heap<Waiter>(byRank);
  private readonly owners = new Map<string, Owner>();
  private turnsWaiting = 0;
  private readingsWaiting = 0;
  private readingsHeld = 0;
  /** Expiry times of slots turns released, oldest first. */
  private readonly lingering: number[] = [];
  /** Each owner whose last turn in flight ended: until when its reserve holds, if it is a review. */
  private readonly holds = new Map<string, number>();
  /** While readings are held back: the earliest lingering slot's or counted hold's expiry. */
  private wakeAt: number | undefined;
  private timer: { readonly handle: unknown; readonly at: number } | undefined;
  constructor(
    private readonly lingerMs: number,
    private readonly timers: Timers,
    private readonly wake: () => void,
    private readonly turnReserve: number,
  ) {}
  get size() {
    return (
      this.turnsWaiting +
      this.readingsWaiting +
      this.preparation.size +
      this.speculation.size
    );
  }
  get readings() {
    return { waiting: this.readingsWaiting, held: this.readingsHeld };
  }
  add(w: Waiter) {
    if (isBackground(w)) {
      this[w.request.priority.class as "preparation" | "speculation"].add(w);
      return;
    }
    let owner = this.owners.get(w.request.owner);
    if (!owner) {
      owner = {
        turns: new Heap(byRank),
        readings: new Heap(byRisk),
        inFlight: 0,
        turnsInFlight: 0,
        started: false,
      };
      this.owners.set(w.request.owner, owner);
    }
    if (isReading(w)) {
      owner.readings.add(w);
      this.readingsWaiting++;
    } else {
      owner.turns.add(w);
      this.turnsWaiting++;
    }
  }
  /** A waiter leaves without a slot. */
  remove(w: Waiter) {
    const owner = this.unqueue(w);
    if (owner) this.forget(w.request.owner, owner);
  }
  /** A waiter takes a slot; a turn takes the oldest lingering one. */
  take(w: Waiter) {
    const owner = this.unqueue(w);
    if (!owner) return;
    owner.inFlight++;
    if (isReading(w)) this.readingsHeld++;
    else {
      owner.turnsInFlight++;
      owner.started = true;
      this.holds.delete(w.request.owner);
      this.lingering.shift();
    }
  }
  released(w: Waiter, now: number) {
    if (isBackground(w)) return;
    const owner = this.owners.get(w.request.owner);
    if (owner) {
      owner.inFlight--;
      if (isReading(w)) owner.started = true;
      else if (!--owner.turnsInFlight && this.lingerMs > 0)
        this.holds.set(w.request.owner, now + this.lingerMs);
      this.forget(w.request.owner, owner);
    }
    if (isReading(w)) this.readingsHeld--;
    else if (this.lingerMs > 0) this.lingering.push(now + this.lingerMs);
  }
  /** Each drain starts here, so a drain that never reaches `next` (no slot free) arms no wake. */
  expire(now: number) {
    this.wakeAt = undefined;
    while (this.lingering[0] !== undefined && this.lingering[0] <= now)
      this.lingering.shift();
    for (const [key, until] of this.holds)
      if (until <= now) this.holds.delete(key);
  }
  /** The next call for a free slot, if any may take it now; `leased` counts each review's leases. */
  next(
    held: number,
    limit: number,
    now: number,
    leased?: ReadonlyMap<string, number>,
  ): Waiter | undefined {
    const turn = this.head((owner) => owner.turns.peek(), byRank),
      reading = this.head((owner) => owner.readings.peek(), byArrival),
      share = Math.min(limit - 1, Math.max(1, Math.floor(limit / 4)));
    if (turn && reading) return this.readingsHeld < share ? reading : turn;
    if (turn) return turn;
    if (reading) {
      const reserve = this.reserved(limit, leased),
        kept = Math.max(
          this.lingering.length,
          Math.min(limit - share, reserve.sum),
        );
      if (held + kept < limit || this.readingsHeld < share) return reading;
      const at = Math.min(
        this.lingering[0] ?? Infinity,
        reserve.lapse ?? Infinity,
      );
      this.wakeAt = at === Infinity ? undefined : at;
      return undefined;
    }
    return nextBackground(this.preparation, this.speculation, now);
  }
  /** After a drain: wake at the earliest expiry that may let a held-back reading in. */
  settle(now: number) {
    const at = this.wakeAt;
    if (this.timer && this.timer.at !== at) this.close();
    if (at !== undefined && !this.timer)
      this.timer = {
        at,
        handle: this.timers.set(
          () => {
            this.timer = undefined;
            this.wake();
          },
          Math.max(0, at - now),
        ),
      };
  }
  close() {
    if (this.timer) this.timers.clear(this.timer.handle);
    this.timer = undefined;
  }
  /**
   * The sum over owners of the free slots each keeps from readings (see the class comment), and the
   * earliest expiry of a hold it counts. A held review's entry may have been forgotten.
   */
  private reserved(limit: number, leased?: ReadonlyMap<string, number>) {
    const turn = Math.min(this.turnReserve, Math.floor(limit / 2));
    let sum = 0,
      lapse: number | undefined;
    if (!turn) return { sum, lapse };
    const hold = (key: string) => {
      const until = leased?.has(key) ? this.holds.get(key) : undefined;
      if (until !== undefined) lapse = Math.min(lapse ?? until, until);
      return until !== undefined;
    };
    for (const [key, owner] of this.owners)
      if (
        (owner.turnsInFlight && leased?.has(key)) ||
        (!owner.turnsInFlight && hold(key)) ||
        (!owner.started &&
          (owner.readings.size || owner.inFlight > owner.turnsInFlight))
      )
        sum += Math.max(0, turn - owner.turnsInFlight);
    for (const key of this.holds.keys())
      if (!this.owners.has(key) && hold(key)) sum += turn;
    return { sum, lapse };
  }
  /** Takes `w` out of its heap; the owner entry for an interactive waiter. */
  private unqueue(w: Waiter) {
    if (isBackground(w)) {
      this[w.request.priority.class as "preparation" | "speculation"].remove(w);
      return undefined;
    }
    const owner = this.owners.get(w.request.owner);
    if (!owner) return undefined;
    if (isReading(w)) {
      owner.readings.remove(w);
      this.readingsWaiting--;
    } else {
      owner.turns.remove(w);
      this.turnsWaiting--;
    }
    return owner;
  }
  private forget(key: string, owner: Owner) {
    if (!owner.inFlight && !owner.turns.size && !owner.readings.size)
      this.owners.delete(key);
  }
  /** The owner with the fewest calls in flight; ties go to the better head by `compare`. */
  private head(
    peek: (owner: Owner) => Waiter | undefined,
    compare: (a: Waiter, b: Waiter) => number,
  ) {
    let best: { inFlight: number; waiter: Waiter } | undefined;
    for (const owner of this.owners.values()) {
      const waiter = peek(owner);
      if (
        waiter &&
        (!best ||
          owner.inFlight < best.inFlight ||
          (owner.inFlight === best.inFlight &&
            compare(waiter, best.waiter) < 0))
      )
        best = { inFlight: owner.inFlight, waiter };
    }
    return best?.waiter;
  }
}
type ProviderState = {
  held: number;
  limiter: ProviderLimit;
  numbers: Numbers;
  queue: ProviderQueue;
  lastUsed: number;
};
export class Scheduler implements Budget {
  private readonly cpu = new Waiting();
  /** Each account's live review leases: how many each owner holds (two of one owner can overlap). */
  private readonly active = new Map<string, Map<string, number>>();
  private readonly providers = new Map<string, ProviderState>();
  private waiting = 0;
  private backgroundWaiting = 0;
  private held = 0;
  private background = 0;
  private sequence = 0;
  private backgroundYields = 0;
  private lastCpuBackground = false;
  private scheduled = false;
  readonly reserve: number;
  readonly backgroundCap: number;
  private readonly lingerMs: number;
  private readonly timers: Timers;
  private readonly turnReserve: number;
  constructor(
    readonly threads: number,
    efficiency: number = threads,
    private readonly fixed?: number,
    private readonly emit: (numbers: Numbers) => void = () => {},
    private readonly now = Date.now,
    private readonly interactiveFloor = false,
    options: SchedulerOptions = {},
  ) {
    if (!Number.isInteger(threads) || threads < 1 || threads > 1024)
      throw new Error("Invalid CPU budget");
    if (
      fixed !== undefined &&
      (!Number.isInteger(fixed) || fixed < 1 || fixed > 32)
    )
      throw new Error("Fixed concurrency must be 1..32");
    this.lingerMs = options.lingerMs ?? TURN_LINGER_MS;
    if (!Number.isInteger(this.lingerMs) || this.lingerMs < 0)
      throw new Error("Turn linger must be a whole number of milliseconds");
    this.timers = options.timers ?? systemTimers;
    this.turnReserve = options.turnReserve ?? TURN_RESERVE;
    if (!Number.isInteger(this.turnReserve) || this.turnReserve < 0)
      throw new Error("Turn reserve must be a whole number of slots");
    this.reserve = threads === 1 ? 0 : Math.max(1, Math.floor(threads / 4));
    this.backgroundCap = Math.max(
      1,
      Math.min(threads - this.reserve, efficiency),
    );
  }
  async activate(account: string, input: string): Promise<ReviewLease> {
    z.string()
      .regex(/^[a-f0-9]{64}$/)
      .parse(account);
    const owner = z.string().min(1).max(OWNER_LENGTH).parse(budgetOwner(input));
    if (this.activeRuns() >= 1024) throw new Error("Active review budget full");
    const runs = this.active.get(account) ?? new Map<string, number>();
    runs.set(owner, (runs.get(owner) ?? 0) + 1);
    this.active.set(account, runs);
    let open = true;
    return () => {
      if (!open) return;
      open = false;
      const left = (runs.get(owner) ?? 1) - 1;
      if (left) runs.set(owner, left);
      else runs.delete(owner);
      if (!runs.size) this.active.delete(account);
      this.schedule();
    };
  }
  async throttle(account: string, retryAfter = false, throttled = true) {
    this.providers.get(account)?.limiter.congested(retryAfter, throttled);
  }
  async measure(account: string): Promise<Numbers> {
    return {
      ...(this.providers.get(account)?.numbers ?? {
        limit: this.fixed ?? 8,
        limitChanges: 0,
      }),
      floor: 0,
    };
  }
  async capacity() {
    return {
      threads: this.threads,
      reserve: this.reserve,
      backgroundCap: this.backgroundCap,
      // This host orders readings, so a client knows a refusal of one is genuine.
      readings: 1,
    };
  }
  async observe() {
    const providers = [...this.providers.values()];
    return {
      held: this.held,
      background: this.background,
      waiting: this.waiting,
      backgroundYields: this.backgroundYields,
      providerHeld: providers.reduce((n, p) => n + p.held, 0),
      providerAccounts: this.providers.size,
      activeRuns: this.activeRuns(),
      readingsWaiting: providers.reduce(
        (n, p) => n + p.queue.readings.waiting,
        0,
      ),
      readingsHeld: providers.reduce((n, p) => n + p.queue.readings.held, 0),
    };
  }
  admit(input: Request, signal?: AbortSignal): Promise<Grant> {
    const request = Request.parse({
        ...input,
        owner: budgetOwner(input.owner),
      }),
      bg = request.priority.class !== "interactive";
    if (signal?.aborted)
      return Promise.reject(new Error("Budget wait aborted"));
    if (this.waiting >= 4096 || (bg && this.backgroundWaiting >= 3072))
      return Promise.reject(new Error("Budget queue full"));
    for (const [key, p] of this.providers)
      if (!p.held && !p.queue.size && this.now() - p.lastUsed >= 60_000)
        this.drop(key, p);
    let provider: ProviderState | undefined;
    if (request.resource.kind === "provider") {
      provider = this.providers.get(request.resource.account);
      if (!provider) {
        if (this.providers.size >= (bg ? 48 : 64)) {
          const idle = [...this.providers].find(
            ([, p]) => !p.held && !p.queue.size,
          );
          if (idle) this.drop(...idle);
          else return Promise.reject(new Error("Provider account budget full"));
        }
        const numbers: Numbers = { limitChanges: 0 };
        provider = {
          held: 0,
          numbers,
          queue: new ProviderQueue(
            this.lingerMs,
            this.timers,
            () => this.schedule(),
            this.turnReserve,
          ),
          lastUsed: this.now(),
          limiter: new ProviderLimit(
            this.fixed,
            (event) => {
              Object.assign(numbers, event);
              if (event.change)
                numbers.limitChanges = (numbers.limitChanges ?? 0) + 1;
              this.emit(event);
            },
            this.now,
          ),
        };
        this.providers.set(request.resource.account, provider);
      }
    }
    const pool = provider?.queue ?? this.cpu;
    return new Promise((admit, refuse) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const abort = () => {
        this.remove(pool, waiter);
        refuse(new Error("Budget wait aborted"));
        this.schedule();
      };
      const yieldBackground = () => {
        this.backgroundYields++;
        this.remove(pool, waiter);
        refuse(new BackgroundYield());
        this.schedule();
      };
      const waiter: Waiter = {
        request,
        at: Math.min(request.queuedAt ?? this.now(), this.now()),
        sequence: this.sequence++,
        admit,
        refuse,
        cleanup: () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
        },
      };
      if (bg) timer = setTimeout(yieldBackground, 300_000);
      signal?.addEventListener("abort", abort, { once: true });
      pool.add(waiter);
      this.waiting++;
      if (bg) this.backgroundWaiting++;
      this.schedule();
    });
  }
  private activeRuns() {
    let leases = 0;
    for (const runs of this.active.values())
      for (const count of runs.values()) leases += count;
    return leases;
  }
  private drop(account: string, provider: ProviderState) {
    provider.queue.close();
    this.providers.delete(account);
  }
  private remove(pool: Waiting | ProviderQueue, w: Waiter) {
    pool.remove(w);
    this.dequeued(w);
  }
  private dequeued(w: Waiter) {
    w.cleanup();
    this.waiting--;
    if (w.request.priority.class !== "interactive") this.backgroundWaiting--;
  }
  private schedule() {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      this.drain();
    });
  }
  private grant(w: Waiter, permits: number, provider?: ProviderState) {
    const bg = w.request.priority.class !== "interactive";
    if (provider) provider.queue.take(w);
    else this.cpu.remove(w);
    this.dequeued(w);
    if (provider) {
      provider.held++;
      provider.limiter.used(provider.held);
      provider.lastUsed = this.now();
    } else {
      this.held += permits;
      if (bg) this.background += permits;
      this.lastCpuBackground = bg;
    }
    let released = false;
    w.admit({
      permits,
      ...(provider ? { numbers: { ...provider.numbers, floor: 0 } } : {}),
      release: (observation) => {
        if (released) return;
        released = true;
        if (provider) {
          provider.held--;
          provider.lastUsed = this.now();
          provider.queue.released(w, this.now());
          if (observation) provider.limiter.record(observation);
        } else {
          this.held -= permits;
          if (bg) this.background -= permits;
        }
        this.schedule();
      },
    });
  }
  private drain() {
    for (const [account, provider] of this.providers) {
      const now = this.now();
      provider.queue.expire(now);
      while (provider.held < provider.limiter.limit) {
        const w = provider.queue.next(
          provider.held,
          provider.limiter.limit,
          now,
          this.active.get(account),
        );
        if (!w) break;
        if (
          w.request.priority.class !== "interactive" &&
          (this.interactiveFloor || this.active.has(account)) &&
          provider.held >= Math.max(0, provider.limiter.limit - 1)
        )
          break;
        this.grant(w, 1, provider);
      }
      provider.queue.settle(now);
    }
    while (this.held < this.threads) {
      const bgNext = this.cpu.background(this.now());
      let w =
        this.threads === 1 && !this.lastCpuBackground && bgNext
          ? bgNext
          : this.cpu.next(this.now());
      if (!w) break;
      let bg = w.request.priority.class !== "interactive";
      let permits =
        w.request.resource.kind === "cpu"
          ? Math.min(
              w.request.resource.permits,
              bg
                ? this.backgroundCap
                : Math.max(1, Math.ceil(this.threads / 2)),
            )
          : 1;
      if (bg)
        permits = Math.min(
          permits,
          this.threads - this.held,
          this.backgroundCap - this.background,
        );
      const reserve =
        !!bgNext && this.background === 0 && this.threads > 1 ? 1 : 0;
      if (
        permits < 1 ||
        this.held + permits > this.threads - (bg ? 0 : reserve)
      ) {
        if (
          !bg &&
          bgNext &&
          this.background === 0 &&
          this.threads - this.held > 0
        ) {
          w = bgNext;
          bg = true;
          permits = 1;
        } else break;
      }
      this.grant(w, permits);
    }
  }
}
