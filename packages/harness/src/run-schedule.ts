import type { PipelineConfig } from "./config.ts";

/**
 * Generated Records fixture on Modal's four CPUs: 1,500 units in 5.976 s, 3,000 in 11.850 s.
 * Reserve ceil(3 * max(measurements) / 5 s) * 5 s: 40 s for collect, compose and Publish.
 * The multiplier leaves twice the measured Publish cost for collection and composition.
 */
export const PUBLISH_WINDOW_MS = 40_000;
export const CUTOFF_GRACE_MS = 5_000;
export const CLEANUP_MARGIN_MS = 5_000;
export const FINALIZATION_MARGIN_MS =
  PUBLISH_WINDOW_MS + CUTOFF_GRACE_MS + CLEANUP_MARGIN_MS;

/** The model-work cutoff for current and older frozen requests. */
export const effectiveCutoffAt = (
  startedAt: number,
  budgets: PipelineConfig["budgets"],
) =>
  startedAt +
  Math.max(
    1,
    Math.min(budgets.cutoffMs, budgets.lifetimeMs - FINALIZATION_MARGIN_MS),
  );
