import { DEFAULT_LIMITS } from "./types.ts";
// Filing is bounded by the raw byte cap. No scan or Records worker wait enters host shutdown.
export const FILING_TIMEOUT_MS =
  60_000 + Math.ceil(DEFAULT_LIMITS.totalBytes / 1024 ** 2) * 50;
export const FILING_DRAIN_MS = 15_000;
