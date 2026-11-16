/** Shared shapes for B4 scoring; rankings and their items are in ../ranking.ts. */

export const GRADES = [
  "necessary",
  "useful",
  "misleading",
  "irrelevant",
] as const;
export type Grade = (typeof GRADES)[number];

/** A gold region a pass 1 retriever can return: a base span outside the range's changes (4.12). */
export interface GoldSpan {
  readonly id: string;
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly kind: string;
  readonly grade: "necessary" | "useful";
  readonly source: "pool" | "addition";
  readonly availability: string;
}

export interface JudgedLabel {
  readonly grade: Grade;
  readonly target: boolean;
}

export interface JudgedCandidate extends JudgedLabel {
  readonly key: string;
  readonly startLine: number;
  readonly endLine: number;
}

/** An arm's pooled item: its 1-based rank in the arm's frozen list and its span key. */
export const pooledKey = (arm: string, rank: number, key: string) =>
  `${arm}\u0000${rank}\u0000${key}`;

export interface HunkGold {
  readonly caseId: string;
  readonly hunkId: string;
  readonly necessary: ReadonlyArray<GoldSpan>;
  readonly useful: ReadonlyArray<GoldSpan>;
  /**
   * Every judged base span by key with its resolved grade, and whether it is a retrieval target.
   * Non-targets (same-batch regions) are neither credited nor counted as wrong attributions.
   */
  readonly judged: ReadonlyMap<string, JudgedLabel>;
  /**
   * Judged pool candidates by path. B3 merges overlapping arm regions into one candidate and labellers
   * judge the merged span, so an item inside a candidate's span takes that candidate's grade.
   */
  readonly candidates: ReadonlyMap<string, ReadonlyArray<JudgedCandidate>>;
  /** Each arm's pooled item, `pooledKey(arm, rank, span)`, to its candidate's span key (pool.json sources). */
  readonly pooled: ReadonlyMap<string, string>;
  /** Gold kept out of pass 1 scoring, by reason: counted, never silently dropped. */
  readonly excluded: Readonly<Record<string, number>>;
  /** Relevant base targets that came from labeller additions (9.16). */
  readonly fromAdditions: {
    readonly necessary: number;
    readonly useful: number;
  };
  /** Identical relevant spans listed more than once (kept once, highest grade). */
  readonly duplicateSpans: number;
  /** Distinct relevant targets of one grade that overlap each other (kept; reported). */
  readonly overlappingSpans: number;
}

/** Every allowance on the 9.14 curve, at doubling steps for the 9.18 saturation point. */
export const ALLOWANCES = [
  4_000, 8_000, 16_000, 32_000, 64_000, 128_000, 256_000, 512_000,
] as const;
export const SHARES = ["opus", "sol"] as const;
export type Share = (typeof SHARES)[number];
/**
 * A curve point: a fixed allowance, each hunk's own real share (9.17 with the 9.23 floor), or its
 * computed share before the floor (a sensitivity reading).
 */
export type Budget = number | Share | `computed-${Share}`;
export const budgetLabel = (budget: Budget) =>
  typeof budget === "number"
    ? `${budget / 1000}k`
    : budget.startsWith("computed-")
      ? budget
      : `real-${budget}`;
