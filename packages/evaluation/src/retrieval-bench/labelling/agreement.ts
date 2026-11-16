import { GRADES, type Grade } from "./schema.ts";

/**
 * Agreement between two labellers on the pooled candidates (brief, "Agreement"): raw agreement and
 * Cohen's kappa on the four grades, on relevant (necessary or useful) against the rest, and on
 * necessary against the rest. Additions are compared separately (additions.ts).
 */

export interface Agreement {
  readonly candidates: number;
  readonly confusion: Record<Grade, Record<Grade, number>>;
  readonly fourGrade: {
    readonly agreement: number;
    readonly kappa: number | null;
  };
  readonly relevant: {
    readonly agreement: number;
    readonly kappa: number | null;
  };
  readonly necessary: {
    readonly agreement: number;
    readonly kappa: number | null;
  };
}

/** Cohen's kappa for paired labels; null when chance agreement is total (no variation). */
export const cohensKappa = <T extends string>(
  pairs: ReadonlyArray<readonly [T, T]>,
) => {
  if (pairs.length === 0) return { agreement: 0, kappa: null };
  const n = pairs.length;
  let same = 0;
  const left = new Map<T, number>();
  const right = new Map<T, number>();
  for (const [a, b] of pairs) {
    if (a === b) same++;
    left.set(a, (left.get(a) ?? 0) + 1);
    right.set(b, (right.get(b) ?? 0) + 1);
  }
  const observed = same / n;
  let expected = 0;
  for (const [label, count] of left)
    expected += (count / n) * ((right.get(label) ?? 0) / n);
  return {
    agreement: observed,
    kappa: expected >= 1 ? null : (observed - expected) / (1 - expected),
  };
};

export const agreement = (
  a: ReadonlyMap<string, Grade>,
  b: ReadonlyMap<string, Grade>,
): Agreement => {
  const ids = [...a.keys()].filter((id) => b.has(id)).sort();
  const confusion = Object.fromEntries(
    GRADES.map((row) => [
      row,
      Object.fromEntries(GRADES.map((col) => [col, 0])),
    ]),
  ) as Record<Grade, Record<Grade, number>>;
  const pairs = ids.map((id) => [a.get(id)!, b.get(id)!] as const);
  for (const [x, y] of pairs) confusion[x][y]++;
  const relevant = (grade: Grade) =>
    grade === "necessary" || grade === "useful" ? "relevant" : "other";
  const necessary = (grade: Grade) =>
    grade === "necessary" ? "necessary" : "other";
  return {
    candidates: ids.length,
    confusion,
    fourGrade: cohensKappa(pairs),
    relevant: cohensKappa(
      pairs.map(([x, y]) => [relevant(x), relevant(y)] as const),
    ),
    necessary: cohensKappa(
      pairs.map(([x, y]) => [necessary(x), necessary(y)] as const),
    ),
  };
};
