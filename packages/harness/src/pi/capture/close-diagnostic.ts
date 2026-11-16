import { UsageCounter } from "./inspection-protocol.ts";
import { z } from "zod";
import {
  CloseInventory,
  MAX_CLOSE_MS,
  NO_PROGRESS_REASON,
} from "./watchdog.ts";

const Count = z.int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const Counter = z.enum([
  "units",
  "fullChecks",
  "fullBytes",
  "matches",
  "parseUnits",
  "decodeUnits",
  "parseValueUnits",
  "depth",
  "yieldUnits",
]);
const Counters = z.partialRecord(Counter, Count);
export {
  PrivateCheck,
  CloseReasonPatterns,
  CloseReasons,
  PublicRefusal,
} from "@neuve/records-schema";
import { PublicRefusal } from "@neuve/records-schema";
export const InspectionProgress = z.strictObject({
  sources: Count,
  workers: Count.min(1).max(4),
  scanMs: Count,
  peakQueuedBytes: Count.max(64 * 1024 * 1024),
  allowance: Counters.optional(),
  exhausted: UsageCounter.optional(),
});
export type InspectionProgress = z.infer<typeof InspectionProgress>;
export const CloseDiagnostic = z.strictObject({
  version: z.literal(1),
  phase: z.enum([
    "read",
    "source-census",
    "inventory",
    "administration",
    "projection",
    "finalization",
  ]),
  outcome: z.enum(["complete", "refused"]),
  refusal: PublicRefusal.optional(),
  inventory: CloseInventory,
  ceilingMs: Count.max(MAX_CLOSE_MS),
  elapsedMs: Count,
  phases: z.partialRecord(
    z.enum([
      "read",
      "source-census",
      "inventory",
      "administration",
      "projection",
      "finalization",
    ]),
    Count,
  ),
  inspection: InspectionProgress.optional(),
  usage: Counters,
  limits: Counters,
});
export type CloseDiagnostic = z.infer<typeof CloseDiagnostic>;
export const renderCloseDiagnostic = (value: CloseDiagnostic) =>
  `capture close: ${JSON.stringify(CloseDiagnostic.parse(value))}`;
export const storedCloseDiagnostic = (
  error: unknown,
): CloseDiagnostic | undefined => {
  let current = error;
  for (
    let depth = 0;
    depth < 8 && current !== null && typeof current === "object";
    depth++
  ) {
    if ("closeDiagnostic" in current) {
      const parsed = CloseDiagnostic.safeParse(current.closeDiagnostic);
      if (parsed.success) return parsed.data;
    }
    current =
      "exportError" in current
        ? current.exportError
        : "cause" in current
          ? current.cause
          : undefined;
  }
  return undefined;
};

const suppressed = "capture close failed (private details suppressed)";
const publicText = (text: string): string => {
  // Never parse unbounded raw errors, and never forward a parser's quoted source token.
  let value = text.slice(0, 8192);
  for (let depth = 0; depth < 8; depth++) {
    const stripped = value.replace(
      /^(?:the harness did not close cleanly \((?:ended|held|interrupted)\): |the harness did not close after a failed open: |export failed: )/,
      "",
    );
    if (stripped === value) break;
    value = stripped;
  }
  if (text.length <= 8192) {
    const exact = PublicRefusal.safeParse(value);
    if (exact.success) return exact.data;
  }
  const journal = /^capture journal line (\d{1,16}): /.exec(value);
  if (journal)
    return `capture journal line ${journal[1]}: invalid JSON (private details suppressed)`;
  if (value.startsWith("native backup of ")) {
    const detail = `native backup: ${value.slice(value.lastIndexOf(": ") + 2)}`;
    return text.length <= 8192 && PublicRefusal.safeParse(detail).success
      ? detail
      : "native backup: private details suppressed";
  }
  const call = /^(?:auxiliary )?call \S+ (.+)$/.exec(value);
  if (call && PublicRefusal.safeParse(call[1]).success)
    return call[1] ?? suppressed;
  const content =
    /^.+ is (\d{1,16}) bytes, over the (\d{1,16})-byte object limit$/.exec(
      value,
    );
  if (content)
    return `capture content is ${content[1]} bytes, over the ${content[2]}-byte object limit`;
  if (/^.+ is not a regular file$/.test(value))
    return "native database is not a regular file";
  if (/^\S+ belongs to run .+, not .+$/.test(value))
    return "capture journal names another run";
  return suppressed;
};

/** Only closed vocabulary and bounded counts can enter a run log or a CLI refusal. */
export const publicCloseReason = (error: unknown): string => {
  let current = error;
  let result = suppressed;
  for (let depth = 0; depth < 8; depth++) {
    const text =
      typeof current === "string"
        ? current
        : current instanceof Error
          ? current.message
          : undefined;
    if (text !== undefined) {
      const parsed = publicText(text);
      if (parsed !== suppressed) result = parsed;
    }
    if (current === null || typeof current !== "object") break;
    current =
      "exportError" in current && current.exportError !== undefined
        ? current.exportError
        : "closeError" in current && current.closeError !== undefined
          ? current.closeError
          : "cause" in current
            ? current.cause
            : undefined;
  }
  return result !== suppressed
    ? result
    : (storedCloseDiagnostic(error)?.refusal ?? suppressed);
};

export const closeFailureRecord = (
  error: unknown,
  mode: "ended" | "held" | "interrupted",
) => ({
  type: "run.close-failed",
  mode,
  error: `the harness did not close cleanly (${mode}): ${publicCloseReason(error)}`,
  closeDiagnostic: storedCloseDiagnostic(error),
});
