/*
 * Whether the branch has moved past the head a batch reviewed (10.103): the
 * overview offers the next review only then. A head that differs is not
 * enough. Checking out an unrelated branch, or resetting behind the reviewed
 * head, is not new work since the review.
 */

import { git } from "./git.server"

const isAncestor = async (at: string, ancestor: string, head: string) =>
  (await git(at, ["merge-base", "--is-ancestor", ancestor, head])).code === 0

/**
 * True when `head` descends from `reviewed` and is not `reviewed` itself.
 * Either revision may be unknown to the repository; then it is false.
 */
export async function movedPast(
  at: string,
  reviewed: string,
  head: string
): Promise<boolean> {
  if (head.startsWith(reviewed) || reviewed.startsWith(head)) return false
  return isAncestor(at, reviewed, head)
}
