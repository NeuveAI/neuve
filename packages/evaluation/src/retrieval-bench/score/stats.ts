import { createHash } from "node:crypto";

/**
 * Statistics for the winner rule (proposal section 5, decision 9.21): a paired bootstrap over
 * families with ranges (cases) nested inside them, 10,000 seeded resamples, a Bonferroni-adjusted
 * interval from the number of pre-registered comparisons, a paired sign-flip permutation test over
 * families as a cross-check, and the single decision rule with the misleading-context guard.
 */

export const BOOTSTRAP_SEED = "neuve-m4-b4-bootstrap-v1";
export const RESAMPLES = 10_000;
export const FAMILY_WISE_ALPHA = 0.05;
/** The non-default arm must beat the default by more than this at the lower bound (9.21). */
export const MARGIN = 0.03;
/** Guard: its wrong-attribution share may exceed the default's by at most this. */
export const GUARD_POINTS = 0.05;

/** sfc32 seeded from SHA-256 of the seed text: deterministic on every platform. */
export const random = (seed: string) => {
  const digest = createHash("sha256").update(seed).digest();
  let a = digest.readUInt32LE(0);
  let b = digest.readUInt32LE(4);
  let c = digest.readUInt32LE(8);
  let d = digest.readUInt32LE(12);
  const next = () => {
    a >>>= 0;
    b >>>= 0;
    c >>>= 0;
    d >>>= 0;
    let t = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    t = (t + d) | 0;
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
  for (let i = 0; i < 15; i++) next();
  return next;
};

/** Type 7 (linear interpolation) quantile of sorted values. */
export const quantile = (sorted: ReadonlyArray<number>, p: number) => {
  if (sorted.length === 0) return Number.NaN;
  const position = (sorted.length - 1) * p;
  const low = Math.floor(position);
  const high = Math.ceil(position);
  const lowValue = sorted[low] as number;
  return lowValue + ((sorted[high] as number) - lowValue) * (position - low);
};

export interface PairedUnit {
  readonly family: string;
  readonly caseId: string;
  readonly delta: number;
}

const mean = (values: ReadonlyArray<number>) =>
  values.reduce((sum, value) => sum + value, 0) / values.length;

/** Families → cases → per-hunk deltas, in a fixed (sorted) order. */
const nest = (units: ReadonlyArray<PairedUnit>) => {
  const families = new Map<string, Map<string, Array<number>>>();
  for (const unit of units) {
    const cases = families.get(unit.family) ?? new Map<string, Array<number>>();
    cases.set(unit.caseId, [...(cases.get(unit.caseId) ?? []), unit.delta]);
    families.set(unit.family, cases);
  }
  return [...families.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([family, cases]) => ({
      family,
      cases: [...cases.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([, deltas]) => mean(deltas)),
    }));
};

/** The point statistic: families weigh equally, cases equally within a family, hunks within a case. */
export const familyStatistic = (units: ReadonlyArray<PairedUnit>) => {
  const nested = nest(units);
  return nested.length === 0
    ? null
    : mean(nested.map((family) => mean(family.cases)));
};

export const bonferroniAlpha = (comparisons: number) =>
  FAMILY_WISE_ALPHA / comparisons;

export const familyBootstrap = (
  units: ReadonlyArray<PairedUnit>,
  options: {
    readonly comparisons: number;
    readonly resamples?: number;
    readonly seed?: string;
  },
) => {
  const nested = nest(units);
  const resamples = options.resamples ?? RESAMPLES;
  const alpha = bonferroniAlpha(options.comparisons);
  if (nested.length === 0)
    return {
      observed: null,
      lower: null,
      upper: null,
      alpha,
      level: 1 - alpha,
      resamples,
      families: 0,
      cases: 0,
      hunks: 0,
    };
  const next = random(options.seed ?? BOOTSTRAP_SEED);
  const pick = (length: number) =>
    Math.min(length - 1, Math.floor(next() * length));
  const stats = new Float64Array(resamples);
  for (let r = 0; r < resamples; r++) {
    let total = 0;
    for (let f = 0; f < nested.length; f++) {
      const family = nested[pick(nested.length)] as (typeof nested)[number];
      let sum = 0;
      for (let c = 0; c < family.cases.length; c++)
        sum += family.cases[pick(family.cases.length)] as number;
      total += sum / family.cases.length;
    }
    stats[r] = total / nested.length;
  }
  const sorted = Array.from(stats).sort((a, b) => a - b);
  return {
    observed: familyStatistic(units),
    lower: quantile(sorted, alpha / 2),
    upper: quantile(sorted, 1 - alpha / 2),
    alpha,
    level: 1 - alpha,
    resamples,
    families: nested.length,
    cases: nested.reduce((sum, family) => sum + family.cases.length, 0),
    hunks: units.length,
  };
};

/** Paired sign-flip permutation test over family means (two-sided), as the cross-check. */
export const familyPermutation = (
  units: ReadonlyArray<PairedUnit>,
  options: { readonly resamples?: number; readonly seed?: string } = {},
) => {
  const values = nest(units).map((family) => mean(family.cases));
  if (values.length === 0) return { p: null, resamples: 0 };
  const resamples = options.resamples ?? RESAMPLES;
  const observed = Math.abs(mean(values));
  const next = random(`${options.seed ?? BOOTSTRAP_SEED}:permutation`);
  let extreme = 0;
  for (let r = 0; r < resamples; r++) {
    let sum = 0;
    for (const value of values) sum += next() < 0.5 ? -value : value;
    if (Math.abs(sum / values.length) >= observed - 1e-12) extreme++;
  }
  return { p: (extreme + 1) / (resamples + 1), resamples };
};

export interface Decision {
  readonly winner: "default" | "other";
  readonly outcome:
    | "other-wins"
    | "inconclusive"
    | "relevant-inconclusive"
    | "guard-failed"
    | "guard-not-measurable"
    | "no-data";
  /** The first condition that failed, or null when the other arm wins. */
  readonly failed: "necessary" | "relevant" | "guard" | null;
  readonly reason: string;
}

/**
 * 9.21 as amended by 9.54: the default (simpler) arm wins unless (a) the other arm's
 * Bonferroni-adjusted lower bound on the necessary-recall delta exceeds +3 points, (b) its lower bound
 * on the relevant-recall delta (necessary and useful together), at the same adjusted level, also
 * exceeds +3 points, and (c) its wrong-attribution share at the real share is at most 5 points above
 * the default's. Requiring both bounds is an intersection-union test, so it needs no further
 * multiplicity correction. Inconclusive data always gives the default. The shares are paired means
 * over the hunks where both arms served a judged item; null means no such hunk, so the guard is not
 * measurable and the default is kept.
 */
export const decide = (input: {
  readonly lower: number | null;
  readonly relevantLower: number | null;
  readonly defaultMisleading: number | null;
  readonly otherMisleading: number | null;
}): Decision => {
  const points = (value: number) => (value * 100).toFixed(1);
  if (input.lower === null)
    return {
      winner: "default",
      outcome: "no-data",
      failed: "necessary",
      reason: "no paired hunk with necessary gold",
    };
  if (input.lower <= MARGIN)
    return {
      winner: "default",
      outcome: "inconclusive",
      failed: "necessary",
      reason: `necessary-recall lower bound ${points(input.lower)} points is not above +${MARGIN * 100}`,
    };
  if (input.relevantLower === null || input.relevantLower <= MARGIN)
    return {
      winner: "default",
      outcome: "relevant-inconclusive",
      failed: "relevant",
      reason:
        input.relevantLower === null
          ? "no paired hunk with relevant gold"
          : `necessary-recall lower bound clears +${MARGIN * 100}, but the relevant-recall lower bound ${points(input.relevantLower)} points does not`,
    };
  if (input.otherMisleading === null || input.defaultMisleading === null)
    return {
      winner: "default",
      outcome: "guard-not-measurable",
      failed: "guard",
      reason: `both lower bounds clear +${MARGIN * 100}, but no paired hunk has a judged served item for both arms, so the misleading guard is not measurable`,
    };
  const guardGap = input.otherMisleading - input.defaultMisleading;
  if (guardGap > GUARD_POINTS + 1e-12)
    return {
      winner: "default",
      outcome: "guard-failed",
      failed: "guard",
      reason: `both lower bounds clear +${MARGIN * 100}, but wrong attribution is ${points(guardGap)} points above the default's (limit ${GUARD_POINTS * 100})`,
    };
  return {
    winner: "other",
    outcome: "other-wins",
    failed: null,
    reason: `lower bounds ${points(input.lower)} (necessary) and ${points(input.relevantLower)} (relevant) points clear +${MARGIN * 100} and the guard holds (${points(guardGap)} points)`,
  };
};
