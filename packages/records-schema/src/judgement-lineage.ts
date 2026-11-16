import { z } from "zod";

export const JudgementLineage = z.strictObject({
  review: z.string(),
  cycle: z.string(),
  head: z.string(),
  judgement: z.string(),
  output: z.string(),
  savedMs: z.number().min(0),
});
export type JudgementLineage = z.infer<typeof JudgementLineage>;
