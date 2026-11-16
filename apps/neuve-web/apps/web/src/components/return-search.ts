import { z } from "zod"

/**
 * The address Ace's coding workspace asks the review to return to (the
 * "Return to channel" link, coding-return.ts). A review address keeps it
 * through its redirects; anything malformed reads as absent.
 */
export const ReturnSearch = z.object({
  returnTo: z.string().max(8192).optional().catch(undefined),
})
