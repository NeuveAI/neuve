import type { Usage } from "@earendil-works/pi-ai";
import type { CallUsage } from "../../route.ts";

/** Provider usage in Records units, preserving cache TTL and optional thinking. */
export const callUsageOf = (usage: Usage): CallUsage => ({
  input: usage.input,
  cacheWrite5m: usage.cacheWrite - (usage.cacheWrite1h ?? 0),
  cacheWrite1h: usage.cacheWrite1h ?? 0,
  cacheRead: usage.cacheRead,
  output: usage.output,
  thinking: usage.reasoning,
});
