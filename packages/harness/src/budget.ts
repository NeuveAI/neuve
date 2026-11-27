import { FINALIZATION_MARGIN_MS } from "./run-schedule.ts";
import { Duration } from "effect";
import { z } from "zod";
import type { RouteConfig } from "./route.ts";

/** Stage names in receipts and frozen settings. */
export const Stage = z.enum([
  "precompute",
  "frame",
  "map",
  "find",
  "verify",
  "link",
  "publish",
]);
export type Stage = z.infer<typeof Stage>;
export type AgentStage = Extract<Stage, "frame" | "map" | "find" | "verify">;

export const FRAME_DEADLINE_MS = 90_000;
export const MAP_DEADLINE_MS = 120_000;
export const PREPARATION_DEADLINE_MS = 270_000;
export const VERIFY_RESERVE_MS = 75_000;

export const preparationDeadline = (start: number, cutoffAt: number) =>
  Math.min(start + PREPARATION_DEADLINE_MS, cutoffAt - VERIFY_RESERVE_MS);

/** Model calls in flight per run, shared by every stage (10.27). */
export const CALLS_IN_FLIGHT = 8;

/** Any one context's input ceiling: half the route's window (10.18). */
export const contextCeiling = (route: RouteConfig) =>
  Math.floor(route.window / 2);

/** A tool result is capped at this many tokens; larger content is paged (10.18). */
export const TOOL_RESULT_TOKENS = 3_000;

/** A run's whole lifetime, from beginning to end (10.15, 10.26): a review's default deadline. */
export const RUN_LIFETIME = Duration.minutes(10);

/** The cut-off comes this long before the end of the run's lifetime (10.42). */
export const CUTOFF_MARGIN = Duration.millis(FINALIZATION_MARGIN_MS);

/** When a run of this lifetime stops starting new work and interrupts running agents (10.42). */
export const runCutoff = (lifetime: Duration.Duration) =>
  Duration.max(Duration.millis(1), Duration.subtract(lifetime, CUTOFF_MARGIN));

/** When a run of the default lifetime stops starting model work: 9:10 (10.42). */
export const RUN_CUTOFF = runCutoff(RUN_LIFETIME);

/** The reminder to finish is appended at this share of the turn limit (proposal §3.4). */
export const REMINDER_SHARE = 0.85;

/** Text-only ends of turn answered with the open items before the final generation (§3.4). */
export const MAX_CONTINUATIONS = 3;

/** Retries after a schema-invalid submission or final answer, before the backstop (§3.5): 1 + 2. */
export const MAX_INVALID_SUBMISSIONS = 2;

/** Attempts per model call for rate limits, overload, 5xx and network errors (§3.5). */
export const MODEL_CALL_ATTEMPTS = 4;

/**
 * UN9's diff-size estimate: bytes divided by 3, times 1.3 for safety. Slice H1 calibrates it against
 * the provider's free token counts (the run log's `estimate` records).
 */
export const estimateTokens = (bytes: number) => Math.ceil((bytes / 3) * 1.3);

/**
 * The tool-result cap in bytes (10.18): the most bytes UN9's estimator counts as at most 3,000
 * tokens, ⌊3,000 × 3 ÷ 1.3⌋. It holds for the whole result the agent sees: header, data tags,
 * page body and the toolkit's budget line.
 */
export const TOOL_RESULT_BYTES = Math.floor((TOOL_RESULT_TOKENS * 3) / 1.3);

/**
 * What a result keeps outside its page body: its header and notes, the data block's tags, and the
 * budget line (turn, cap and allowance use, itself held to `BUDGET_LINE_BYTES`).
 */
export const BUDGET_LINE_BYTES = 600;
export const RESULT_FRAME_BYTES = 700;

/** The bytes a tool's page body may take, so the whole result fits the cap. */
export const PAGE_BODY_BYTES =
  TOOL_RESULT_BYTES - BUDGET_LINE_BYTES - RESULT_FRAME_BYTES;

/**
 * A multi-range read can return up to 20,000 estimated tokens, about 45 KB.
 * The reading budget also limits the combined results of all calls in a Lane review.
 */
export const READ_MANY_RESULT_TOKENS = 20_000;

/** `read_many`'s cap in bytes, by UN9's estimator, as `TOOL_RESULT_BYTES` is for the 3,000. */
export const READ_MANY_RESULT_BYTES = Math.floor(
  (READ_MANY_RESULT_TOKENS * 3) / 1.3,
);

/** What `read_many`'s pages, headers and notes may take, so its whole result fits its cap. */
export const READ_MANY_BODY_BYTES =
  READ_MANY_RESULT_BYTES - BUDGET_LINE_BYTES - RESULT_FRAME_BYTES;

/** Cuts text to at most `max` UTF-8 bytes, never inside a character. */
export const clipBytes = (text: string, max: number) => {
  if (Buffer.byteLength(text) <= max) return text;
  let out = "";
  let used = 0;
  for (const char of text) {
    const size = Buffer.byteLength(char);
    if (used + size > max) break;
    out += char;
    used += size;
  }
  return out;
};
