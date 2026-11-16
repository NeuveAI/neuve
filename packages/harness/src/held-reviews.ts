import { safeRead } from "@neuve/records-schema";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

/**
 * A review job the running worker holds because this process lacks its route's credential (10.17),
 * kept beside the store so `neuve jobs`, `neuve review` and the web app can say why it waits. It
 * names the route and where its credential comes from, never a value. The worker's admission writes
 * it (`handler.ts`); this module is the one definition every reader imports, through the
 * `@neuve/harness/held-reviews` subpath where the whole harness must not load (zod and node:fs only).
 */
export const HeldReview = z.strictObject({
  seq: z.int(),
  pid: z.int(),
  at: z.string(),
  provider: z.enum(["anthropic", "openai"]),
  route: z.string(),
  credential: z.string(),
});
export type HeldReview = z.infer<typeof HeldReview>;

/** Where the held review jobs are kept: `harness/held-reviews.json` in the store's directory. */
export const heldReviewsPath = (location: { readonly directory: string }) =>
  join(location.directory, "harness", "held-reviews.json");

/** The held review jobs on record; only the claim holder's entries are current. */
export const readHeldReviews = (location: {
  readonly directory: string;
}): ReadonlyArray<HeldReview> => {
  const path = heldReviewsPath(location);
  if (!existsSync(path)) return [];
  try {
    const parsed = safeRead(
      z.array(HeldReview),
      JSON.parse(readFileSync(path, "utf8")),
      { source: path },
    );
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
};
