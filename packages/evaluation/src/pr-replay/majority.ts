/**
 * The majority of three (10.135): two labelling passes, and a third independent pass only where
 * they disagree or one gave no answer. The answer two of the three give counts. Three different
 * answers, or a majority of "unsure", leave the item unjudged; so does a tie the third pass could not
 * break because it gave no answer either. Used by concern labelling, post-merge judging, blind
 * matching and merit validation alike. Agreement between the first two passes is still reported, as
 * a minor quality signal.
 */

/** Why an item has no answer: a majority of unsure, three different answers, or too few answers. */
export type Unjudged = "unsure" | "split" | "missing";

export interface Decided<T> {
  /** The majority's answer; null when the item is unjudged. */
  readonly value: T | null;
  readonly why: Unjudged | null;
  /** True when the first two passes disagreed (or one gave nothing) and the third decided it. */
  readonly brokenByThird: boolean;
}

/** Whether the first two answers leave a tie for a third pass to break. */
export const needsThird = <T>(a: T | null, b: T | null) =>
  a === null || b === null || a !== b;

/**
 * The majority of up to three answers, `null` for a pass that gave none (or, for the third, did not
 * run because the first two agreed). `unsure` names the answer that, in the majority, leaves the
 * item unjudged.
 */
export const majority = <T>(
  a: T | null,
  b: T | null,
  c: T | null,
  unsure?: T,
): Decided<T> => {
  const answers = [a, b, c].filter((answer): answer is T => answer !== null);
  const winner = answers.find(
    (answer) => answers.filter((other) => other === answer).length >= 2,
  );
  if (winner === undefined)
    return {
      value: null,
      why: answers.length === 3 ? "split" : "missing",
      brokenByThird: false,
    };
  const brokenByThird = needsThird(a, b);
  if (unsure !== undefined && winner === unsure)
    return { value: null, why: "unsure", brokenByThird };
  return { value: winner, why: null, brokenByThird };
};
