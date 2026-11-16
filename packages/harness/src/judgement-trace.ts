import { z } from "zod";

import { JudgementLineage } from "@neuve/records-schema";
export { JudgementLineage as CarriedFrom } from "@neuve/records-schema";
/** Hashes only leave the read boundary. No tool response text is duplicated in the trace. */
export const VerifyingRead = z.strictObject({
  tool: z.string(),
  args: z.json(),
  result: z.string().regex(/^[0-9a-f]{64}$/),
});
export type VerifyingRead = z.infer<typeof VerifyingRead>;

/** A restarted task contributes once; scheduling a shadow does not count as checking it. */
export const judgementCounts = (
  records: ReadonlyArray<{
    readonly type: string;
    readonly [field: string]: unknown;
  }>,
) => {
  const units = new Map<string, { source: string; savedMs: number }>();
  const shadows = new Map<string, boolean>();
  for (const record of records) {
    if (
      record.type === "judgement" &&
      typeof record["unit"] === "string" &&
      typeof record["source"] === "string"
    )
      units.set(record["unit"], {
        source: record["source"],
        savedMs: typeof record["savedMs"] === "number" ? record["savedMs"] : 0,
      });
    if (
      record.type === "judgement.shadow" &&
      typeof record["judgement"] === "string" &&
      typeof record["agreement"] === "boolean"
    )
      shadows.set(record["judgement"], record["agreement"]);
  }
  return {
    carried: [...units.values()].filter((unit) => unit.source === "carried")
      .length,
    fresh: [...units.values()].filter((unit) => unit.source === "fresh").length,
    shadowChecked: shadows.size,
    shadowAgreed: [...shadows.values()].filter(Boolean).length,
    savedSeconds: [...units.values()].reduce(
      (sum, unit) =>
        sum + (unit.source === "carried" ? unit.savedMs / 1000 : 0),
      0,
    ),
  };
};
