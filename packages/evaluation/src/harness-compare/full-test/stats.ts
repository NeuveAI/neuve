import {
  BOOTSTRAP_SEED,
  RESAMPLES,
  familyBootstrap,
  familyStatistic,
  random,
  type PairedUnit,
} from "../../retrieval-bench/score/stats.ts";

/**
 * The full test's statistics (FT5, FT10, FT11): the pre-registered separability statistic with
 * leave-one-family-out, agreement between runs with Cohen's kappa, the adjusted Rand index and
 * one-to-one set matching for U′. Pure functions over plain values; the bootstraps reuse B4's
 * seeded generator and its family-nested resampling (score/stats.ts).
 */

const mean = (values: ReadonlyArray<number>) =>
  values.length === 0
    ? null
    : values.reduce((sum, value) => sum + value, 0) / values.length;

// Separability (FT5)

/** One hunk's pair of values for a measure: A, and the arm it is compared with. */
export interface PairedValue {
  readonly hunkId: string;
  readonly family: string;
  readonly caseId: string;
  readonly a: number;
  readonly x: number;
}

/** A paired difference summarised both ways FT5 asks: family-weighted and the plain hunk mean. */
export interface DeltaSummary {
  readonly hunks: number;
  readonly families: number;
  /** Mean δ = A − X with the bootstrap's 95% interval. */
  readonly delta: number | null;
  readonly ci95: readonly [number | null, number | null];
  /** Mean |δ| with its 95% interval (the noise floor reads the upper bound of A against A′'s). */
  readonly absDelta: number | null;
  readonly absCi95: readonly [number | null, number | null];
}

const summarise = (units: ReadonlyArray<PairedUnit>): DeltaSummary => {
  const signed = familyBootstrap(units, { comparisons: 1 });
  const abs = familyBootstrap(
    units.map((unit) => ({ ...unit, delta: Math.abs(unit.delta) })),
    { comparisons: 1 },
  );
  return {
    hunks: units.length,
    families: signed.families,
    delta: signed.observed,
    ci95: [signed.lower, signed.upper],
    absDelta: abs.observed,
    absCi95: [abs.lower, abs.upper],
  };
};

/** Both weightings: B4's family nesting, and every hunk its own family (the plain hunk mean). */
export const deltaSummary = (pairs: ReadonlyArray<PairedValue>) => {
  const family = pairs.map((pair) => ({
    family: pair.family,
    caseId: pair.caseId,
    delta: pair.a - pair.x,
  }));
  const plain = pairs.map((pair) => ({
    family: pair.hunkId,
    caseId: pair.hunkId,
    delta: pair.a - pair.x,
  }));
  return { familyWeighted: summarise(family), hunkMean: summarise(plain) };
};

/** The family-weighted summary alone, for leave-one-family-out, which reads only it. */
const familyWeightedSummary = (pairs: ReadonlyArray<PairedValue>) =>
  summarise(
    pairs.map((pair) => ({
      family: pair.family,
      caseId: pair.caseId,
      delta: pair.a - pair.x,
    })),
  );

const excludesZero = (ci: readonly [number | null, number | null]) =>
  (ci[0] !== null && ci[0] > 0) || (ci[1] !== null && ci[1] < 0);

/**
 * FT5's rule: a difference between A and B or C is separable from noise only when its 95% interval
 * excludes zero and its mean |δ| exceeds the upper 95% bound of A against A′'s mean |δ|. Without a
 * noise floor (A′ did not cover these hunks, FT14 rule 7) nothing is called separable.
 */
export const separable = (
  comparison: DeltaSummary,
  noise: DeltaSummary | null,
) => {
  const floor = noise?.absCi95[1] ?? null;
  return {
    floor,
    excludesZero: excludesZero(comparison.ci95),
    aboveFloor:
      floor !== null &&
      comparison.absDelta !== null &&
      comparison.absDelta > floor,
    separable:
      floor !== null &&
      excludesZero(comparison.ci95) &&
      comparison.absDelta !== null &&
      comparison.absDelta > floor,
  };
};

export interface SeparabilityResult {
  readonly comparison: ReturnType<typeof deltaSummary>;
  readonly noise: ReturnType<typeof deltaSummary> | null;
  readonly familyWeighted: ReturnType<typeof separable>;
  readonly hunkMean: ReturnType<typeof separable>;
  /** Each family left out in turn: whether the result keeps its separability and sign without it. */
  readonly leaveOneFamilyOut: ReadonlyArray<{
    readonly family: string;
    readonly delta: number | null;
    readonly separable: boolean;
    readonly losesSeparability: boolean;
    readonly changesSign: boolean;
  }>;
  /** Families the result rests on: leaving one out loses separability or flips the sign. */
  readonly restsOn: ReadonlyArray<string>;
}

/**
 * The whole pre-registered statistic for one measure: A against X, the noise floor from A against
 * A′ over the same hunks where A′ ran, and the leave-one-family-out recomputation (each family left
 * out of both the comparison and its floor).
 */
export const separability = (
  pairs: ReadonlyArray<PairedValue>,
  noisePairs: ReadonlyArray<PairedValue> | null,
): SeparabilityResult => {
  const comparison = deltaSummary(pairs);
  const noise =
    noisePairs === null || noisePairs.length === 0
      ? null
      : deltaSummary(noisePairs);
  const fw = separable(
    comparison.familyWeighted,
    noise?.familyWeighted ?? null,
  );
  const hm = separable(comparison.hunkMean, noise?.hunkMean ?? null);
  const families = [...new Set(pairs.map((pair) => pair.family))].sort();
  const leaveOneFamilyOut =
    families.length < 2
      ? []
      : families.map((family) => {
          const kept = pairs.filter((pair) => pair.family !== family);
          const keptNoise =
            noisePairs?.filter((pair) => pair.family !== family) ?? null;
          const without = familyWeightedSummary(kept);
          const withoutNoise =
            keptNoise === null || keptNoise.length === 0
              ? null
              : familyWeightedSummary(keptNoise);
          const still = separable(without, withoutNoise).separable;
          const sign = (value: number | null) =>
            value === null ? 0 : Math.sign(value);
          return {
            family,
            delta: without.delta,
            separable: still,
            losesSeparability: fw.separable && !still,
            changesSign:
              sign(comparison.familyWeighted.delta) !== 0 &&
              sign(without.delta) !== 0 &&
              sign(without.delta) !== sign(comparison.familyWeighted.delta),
          };
        });
  return {
    comparison,
    noise,
    familyWeighted: fw,
    hunkMean: hm,
    leaveOneFamilyOut,
    restsOn: leaveOneFamilyOut
      .filter((entry) => entry.losesSeparability || entry.changesSign)
      .map((entry) => entry.family),
  };
};

// Agreement (FT10, FT11)

/** One matched item (a hunk, or a unit pair) with its category in each run. */
export interface Rated {
  readonly family: string;
  readonly caseId: string;
  readonly x: string;
  readonly y: string;
}

/** Cohen's kappa over paired ratings; null when there are none, 1 when chance agreement is total. */
export const cohensKappa = (pairs: ReadonlyArray<Rated>) => {
  if (pairs.length === 0)
    return { observed: null, expected: null, kappa: null };
  const n = pairs.length;
  const observed = pairs.filter((pair) => pair.x === pair.y).length / n;
  const categories = new Set(pairs.flatMap((pair) => [pair.x, pair.y]));
  let expected = 0;
  for (const category of categories) {
    const px = pairs.filter((pair) => pair.x === category).length / n;
    const py = pairs.filter((pair) => pair.y === category).length / n;
    expected += px * py;
  }
  const kappa =
    expected === 1
      ? observed === 1
        ? 1
        : 0
      : (observed - expected) / (1 - expected);
  return { observed, expected, kappa };
};

const quantile = (sorted: ReadonlyArray<number>, p: number) => {
  if (sorted.length === 0) return null;
  const position = (sorted.length - 1) * p;
  const low = Math.floor(position);
  const high = Math.ceil(position);
  const lowValue = sorted[low] as number;
  return lowValue + ((sorted[high] as number) - lowValue) * (position - low);
};

/**
 * Raw agreement and Cohen's kappa side by side, each with a family-bootstrap 95% interval:
 * families resampled, then cases within each, then the items of each case pooled (B4's nesting).
 */
export const agreement = (
  pairs: ReadonlyArray<Rated>,
  options: { readonly resamples?: number; readonly seed?: string } = {},
) => {
  const point = cohensKappa(pairs);
  const families = new Map<string, Map<string, Array<Rated>>>();
  for (const pair of pairs) {
    const cases = families.get(pair.family) ?? new Map<string, Array<Rated>>();
    cases.set(pair.caseId, [...(cases.get(pair.caseId) ?? []), pair]);
    families.set(pair.family, cases);
  }
  const nested = [...families.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([, cases]) =>
      [...cases.entries()]
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([, items]) => items),
    );
  const resamples = options.resamples ?? Math.min(RESAMPLES, 2_000);
  const next = random(`${options.seed ?? BOOTSTRAP_SEED}:agreement`);
  const pick = (length: number) =>
    Math.min(length - 1, Math.floor(next() * length));
  const raw: Array<number> = [];
  const kappas: Array<number> = [];
  if (nested.length > 0)
    for (let r = 0; r < resamples; r++) {
      const drawn: Array<Rated> = [];
      for (let f = 0; f < nested.length; f++) {
        const cases = nested[pick(nested.length)]!;
        for (let c = 0; c < cases.length; c++)
          drawn.push(...cases[pick(cases.length)]!);
      }
      const stat = cohensKappa(drawn);
      if (stat.observed !== null) raw.push(stat.observed);
      if (stat.kappa !== null) kappas.push(stat.kappa);
    }
  raw.sort((a, b) => a - b);
  kappas.sort((a, b) => a - b);
  return {
    items: pairs.length,
    families: nested.length,
    agreement: point.observed,
    agreementCi95: [quantile(raw, 0.025), quantile(raw, 0.975)] as const,
    kappa: point.kappa,
    kappaCi95: [quantile(kappas, 0.025), quantile(kappas, 0.975)] as const,
  };
};

// U′'s Understand stability (FT5)

/**
 * The adjusted Rand index (Hubert and Arabie) of two labellings of the same items, over the items
 * both label. 1 is identical clustering; about 0 is chance. Null with fewer than 2 shared items.
 */
export const adjustedRandIndex = (
  a: ReadonlyMap<string, string>,
  b: ReadonlyMap<string, string>,
) => {
  const items = [...a.keys()].filter((item) => b.has(item));
  const n = items.length;
  if (n < 2) return { items: n, ari: null };
  const choose2 = (k: number) => (k * (k - 1)) / 2;
  const cells = new Map<string, number>();
  const rows = new Map<string, number>();
  const cols = new Map<string, number>();
  for (const item of items) {
    const x = a.get(item)!;
    const y = b.get(item)!;
    cells.set(`${x}\u0000${y}`, (cells.get(`${x}\u0000${y}`) ?? 0) + 1);
    rows.set(x, (rows.get(x) ?? 0) + 1);
    cols.set(y, (cols.get(y) ?? 0) + 1);
  }
  const index = [...cells.values()].reduce((sum, k) => sum + choose2(k), 0);
  const sumRows = [...rows.values()].reduce((sum, k) => sum + choose2(k), 0);
  const sumCols = [...cols.values()].reduce((sum, k) => sum + choose2(k), 0);
  const expected = (sumRows * sumCols) / choose2(n);
  const max = (sumRows + sumCols) / 2;
  // Both labellings put every item alone, or both put every item together: identical.
  if (max === expected) return { items: n, ari: 1 };
  return { items: n, ari: (index - expected) / (max - expected) };
};

export const jaccard = <T>(a: ReadonlySet<T>, b: ReadonlySet<T>) => {
  const union = new Set([...a, ...b]).size;
  if (union === 0) return 1;
  return [...a].filter((item) => b.has(item)).length / union;
};

/**
 * One-to-one matching of two sets of groups by Jaccard of their members, greedily from the best
 * pair, keeping a pair only at `threshold` or above. Reported as the matched share both ways.
 */
export const matchGroups = <T>(
  left: ReadonlyArray<{
    readonly id: string;
    readonly members: ReadonlySet<T>;
  }>,
  right: ReadonlyArray<{
    readonly id: string;
    readonly members: ReadonlySet<T>;
  }>,
  threshold = 0.5,
) => {
  const candidates: Array<{ l: string; r: string; score: number }> = [];
  for (const l of left)
    for (const r of right) {
      const score = jaccard(l.members, r.members);
      if (score >= threshold) candidates.push({ l: l.id, r: r.id, score });
    }
  candidates.sort(
    (x, y) =>
      y.score - x.score ||
      (x.l < y.l ? -1 : x.l > y.l ? 1 : x.r < y.r ? -1 : 1),
  );
  const usedL = new Set<string>();
  const usedR = new Set<string>();
  const pairs: Array<{ left: string; right: string; jaccard: number }> = [];
  for (const candidate of candidates) {
    if (usedL.has(candidate.l) || usedR.has(candidate.r)) continue;
    usedL.add(candidate.l);
    usedR.add(candidate.r);
    pairs.push({
      left: candidate.l,
      right: candidate.r,
      jaccard: candidate.score,
    });
  }
  return {
    pairs,
    leftMatched: left.length === 0 ? null : pairs.length / left.length,
    rightMatched: right.length === 0 ? null : pairs.length / right.length,
  };
};

/** Obligation text compared after lower-casing and collapsing whitespace and punctuation. */
export const normaliseText = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/** Obligations matched one to one by their cited basis and normalised text, the matched share both ways. */
export const matchObligations = (
  left: ReadonlyArray<{ readonly basis: string; readonly text: string }>,
  right: ReadonlyArray<{ readonly basis: string; readonly text: string }>,
) => {
  const key = (o: { basis: string; text: string }) =>
    `${o.basis}\u0000${normaliseText(o.text)}`;
  const pool = new Map<string, number>();
  for (const o of right) pool.set(key(o), (pool.get(key(o)) ?? 0) + 1);
  let matched = 0;
  for (const o of left) {
    const held = pool.get(key(o)) ?? 0;
    if (held > 0) {
      matched++;
      pool.set(key(o), held - 1);
    }
  }
  return {
    matched,
    leftMatched: left.length === 0 ? null : matched / left.length,
    rightMatched: right.length === 0 ? null : matched / right.length,
  };
};

export { familyStatistic, mean };
