import type { ArmAnswer, ArmDescription } from "./retriever.ts";

/** Per-arm evidence figures: coverage of the dev hunks, returned tokens and latency. */

const percentile = (values: ReadonlyArray<number>, p: number) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
  );
  return Math.round((sorted[rank] ?? 0) * 10) / 10;
};

export const summarize = (
  description: ArmDescription,
  answers: ReadonlyArray<ArmAnswer>,
  expectedHunks: number,
) => {
  const tokens = answers.map((answer) =>
    answer.regions.reduce((sum, region) => sum + region.tokens, 0),
  );
  const cold = answers
    .filter((answer) => answer.timing.cold)
    .map((answer) => answer.timing.millis);
  const warm = answers
    .filter((answer) => !answer.timing.cold)
    .map((answer) => answer.timing.millis);
  return {
    arm: description.arm,
    family: description.family,
    label: description.label,
    hunks: answers.length,
    expectedHunks,
    empty: answers.filter((answer) => answer.regions.length === 0).length,
    errors: answers.filter(
      (answer) => answer.note?.startsWith("error") === true,
    ).length,
    normalized: answers.filter(
      (answer) => answer.note?.startsWith("normalized") === true,
    ).length,
    regionsPerHunk: {
      p50: percentile(
        answers.map((answer) => answer.regions.length),
        50,
      ),
      min: Math.min(...answers.map((answer) => answer.regions.length)),
    },
    poolTokens: {
      p50: percentile(tokens, 50),
      p95: percentile(tokens, 95),
      total: tokens.reduce((sum, value) => sum + value, 0),
    },
    latencyMillis: {
      cold: {
        n: cold.length,
        p50: percentile(cold, 50),
        p95: percentile(cold, 95),
      },
      warm: {
        n: warm.length,
        p50: percentile(warm, 50),
        p95: percentile(warm, 95),
      },
    },
  };
};
