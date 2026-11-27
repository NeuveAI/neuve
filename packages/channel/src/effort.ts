import { z } from "zod";

export const EffortSchema = z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

/** "off" leaves always-thinking providers at their default; otherwise disables reasoning. */
export type Effort = z.output<typeof EffortSchema>;

export function selectableEfforts(levels: readonly Effort[]): readonly Effort[] {
	return levels.includes("off") ? levels : ["off", ...levels];
}
