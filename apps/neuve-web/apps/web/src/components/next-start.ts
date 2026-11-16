import type { ReviewStart } from "@workspace/ui/neuve/states/review-start"

/**
 * What the Reviews page offers beside its list (10.103): the review that
 * runs; the newest review again when it failed, even when no review has
 * finished; else the branch as "Start a review" would review it, only when
 * its head descends from the newest finished review's (an unrelated branch or
 * a reset is no new work). Nothing when git can't say.
 */
export async function nextStart(
  /** The head the newest finished review reviewed, when one finished. */
  reviewed: string | undefined,
  start: ReviewStart | undefined,
  movedPast: (reviewed: string, head: string) => Promise<boolean>
): Promise<ReviewStart | undefined> {
  if (start?.status === "running") return start
  if (start?.status !== "ready") return undefined
  if (start.failure !== undefined) return start
  if (reviewed === undefined) return undefined
  const moved = await movedPast(reviewed, start.preview.headOid).catch(
    () => false
  )
  return moved ? start : undefined
}
