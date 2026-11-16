// Why (NEU-148, the published texts): a reading's text over its bound is kept clipped (requirements,
// factors, impact entries, a file's checked line and the rest), and Records shows it to a person as
// written. Cut mid-word it reads as broken ("invalid kinds remain rejecte"), so a clipped text must
// end at a word with an ellipsis, inside its bound, and a text within its bound must stay whole.
import { expect, test } from "bun:test";
import {
  ANSWER_BOUNDS,
  CLIPPED,
  assessRepair,
  clip,
  readingIndex,
} from "../src/readings/answers.ts";

/** One file of one section, as a reading lists it. */
const index = readingIndex({
  files: [{ index: 0, path: "src/a.ts", rows: [] }],
  sections: [
    {
      index: 1,
      key: "k1",
      file: 0,
      owned: [{ side: "new", startLine: 10, endLine: 20 }],
    },
  ],
  facts: [],
  proofs: [],
});

const length = (text: string) => [...text].length;

/** Whether a clipped text ends at a word: the kept words are a prefix of the text's own words. */
const endsAtWord = (clipped: string, whole: string) => {
  const kept = clipped.slice(0, -CLIPPED.length);
  return (
    whole.startsWith(kept) &&
    (whole.length === kept.length || /\s/u.test(whole[kept.length]!))
  );
};

// Reason: the cut seen in Records (a requirement at 90 characters, cut inside "rejected").
test("a clipped text ends at the last word inside its bound, with an ellipsis, never inside a word", () => {
  const whole =
    "Distinct Python relative modules are accepted; duplicates and invalid kinds remain rejected by the decoder.";
  const bound = ANSWER_BOUNDS.requirementText;
  const clipped = clip(whole, bound);
  expect(clipped).toBe(
    "Distinct Python relative modules are accepted; duplicates and invalid kinds remain…",
  );
  expect(clipped.endsWith(CLIPPED)).toBe(true);
  expect(length(clipped)).toBeLessThanOrEqual(bound);
  expect(endsAtWord(clipped, whole)).toBe(true);
  for (let cut = 2; cut < length(whole); cut++) {
    const at = clip(whole, cut);
    expect(length(at)).toBeLessThanOrEqual(cut);
    expect(at.endsWith(CLIPPED)).toBe(true);
    // Every cut inside the first word must cut that word; every later one ends at a word.
    if (cut > "Distinct ".length) expect(endsAtWord(at, whole)).toBe(true);
  }
});

// Reason: the bound is kept, and only a text over it is changed.
test("a text within its bound is kept whole; a bound of nothing keeps nothing; a cut just before a space keeps the word", () => {
  expect(clip("short enough", 12)).toBe("short enough");
  expect(clip("anything", 0)).toBe("");
  expect(clip("one two three", 8)).toBe("one two…");
  expect(clip("one two three", 9)).toBe("one two…");
  // One long word has no boundary to cut at: cut at the bound, with the ellipsis.
  expect(clip("abcdefghij", 5)).toBe("abcd…");
  // Never inside a character: an emoji is one code point.
  expect(clip("\u{1F600}\u{1F600}\u{1F600}", 2)).toBe("\u{1F600}…");
});

// Reason: the stored answer is where a person's text comes from; its repair is what clips it.
test("a repaired Assess answer keeps each over-long text clipped at a word, with the ellipsis, inside its bound", () => {
  const long = (n: number) =>
    Array.from({ length: n }, (_, at) => `word${at}`).join(" ");
  const repaired = assessRepair(
    {
      factors: [{ f: "connections", t: long(40), cites: [] }],
      requirements: [
        {
          t: long(40),
          kinds: ["test-run"],
          cites: [],
          testable: true,
          untested: "",
          proof: [],
          agree: true,
        },
      ],
      impact: [{ s: 1, effect: "changed", t: long(40), cites: [] }],
      classes: [
        { S: [1], c: "l", v: "e", F: [0], R: [0], person: null, gaps: null },
      ],
    },
    index,
  ).answer!;
  const texts = [
    [repaired.factors[0]!.t, ANSWER_BOUNDS.factorText],
    [repaired.requirements[0]!.t, ANSWER_BOUNDS.requirementText],
    [repaired.impact[0]!.t, ANSWER_BOUNDS.impactText],
  ] as const;
  for (const [text, bound] of texts) {
    expect(length(text)).toBeLessThanOrEqual(bound);
    expect(text.endsWith(CLIPPED)).toBe(true);
    expect(endsAtWord(text, long(40))).toBe(true);
  }
});
