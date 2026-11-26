import { z } from "zod";

/** A cited investigation, not four checklist booleans or four required mini-reports. */
export const ReviewCheck = z.strictObject({
  s: z.int().min(1),
  checked: z.string().min(1).max(600),
  cites: z.array(z.string().min(1)).min(1).max(8),
});
export type ReviewCheck = z.infer<typeof ReviewCheck>;
