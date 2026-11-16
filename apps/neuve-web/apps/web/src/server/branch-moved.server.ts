/*
 * Whether the branch has moved past the head a batch reviewed (10.103): the
 * overview offers the next review only then. A head that differs is not
 * enough. Checking out an unrelated branch, or resetting behind the reviewed
 * head, is not new work since the review.
 */

const isAncestor = async (at: string, ancestor: string, head: string) => {
  const child = Bun.spawn(
    ["git", "-C", at, "merge-base", "--is-ancestor", ancestor, head],
    { stdout: "ignore", stderr: "ignore" }
  )
  return (await child.exited) === 0
}

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
