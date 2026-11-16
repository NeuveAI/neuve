import type { Stage } from "./budget.ts";
import type { StubSettings } from "./config.ts";

export const cutoffReached = (now: number, cutoffAt: number): boolean =>
  now >= cutoffAt;

export const cutoffNotes = {
  skipped: "not started: the run reached its cut-off (10.42)",
  held: "interrupted at the run's cut-off (10.42) while held by a stub setting",
} as const;

type StartPolicy =
  | { readonly kind: "skip" }
  | { readonly kind: "start"; readonly holdMs: number | undefined };

/** Admission policy only: the caller owns its clock, stored lookup, sleep and durable state. */
export const stageStartPolicy = (input: {
  readonly now: number;
  readonly cutoffAt: number;
  readonly stored: boolean;
  readonly afterCutoff: boolean;
  readonly holdable: boolean;
  readonly stage: Stage;
  readonly hold: StubSettings["hold"];
}): StartPolicy => {
  if (
    cutoffReached(input.now, input.cutoffAt) &&
    !input.stored &&
    !input.afterCutoff
  )
    return { kind: "skip" };
  const hold = input.hold;
  return {
    kind: "start",
    holdMs:
      input.holdable &&
      !input.stored &&
      !cutoffReached(input.now, input.cutoffAt) &&
      hold !== undefined &&
      (hold.at ?? "start") === "start" &&
      hold.stage === input.stage
        ? Math.min(hold.seconds * 1_000, input.cutoffAt - input.now)
        : undefined,
  };
};
