import { GitCommitHorizontalIcon, LoaderCircleIcon } from "lucide-react"

import { StartReviewButton } from "@workspace/ui/neuve/states/start-review"
import type { StartReviewHandler } from "@workspace/ui/neuve/states/start-review"
import type { ReviewStart } from "@workspace/ui/neuve/states/review-start"

const short = (oid: string) => oid.slice(0, 7)

/** One revision named in full or by a prefix of the other. */
const sameRevision = (a: string, b: string) =>
  a.startsWith(b) || b.startsWith(a)

/**
 * The branch has moved past the head this batch reviewed: the next review is
 * the one strong action on the page (10.103). The host passes a ready start
 * only when its head descends from the reviewed one. While that review runs,
 * the notice says so instead. Nothing shows when the branch still points at
 * the reviewed head.
 */
export function NewWorkNotice({
  start,
  revision,
  onStartReview,
  since = "this review",
}: {
  start: ReviewStart | undefined
  /** The head this batch reviewed. */
  revision: string
  onStartReview?: StartReviewHandler
  /** The review the work is new since, as the page names it. */
  since?: string
}) {
  if (start?.status === "running")
    return (
      <div
        role="status"
        className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-[14px] bg-surface px-5 py-4 shadow-[0_0_0_1px_var(--nv-line)]"
      >
        <LoaderCircleIcon
          aria-hidden="true"
          className="size-[18px] shrink-0 text-ink-muted motion-safe:animate-pending-spin"
          strokeWidth={1.75}
        />
        <span className="text-[15px] font-semibold">
          Reviewing{" "}
          <code translate="no" className="font-mono text-[14px]">
            {start.run.subject}
          </code>
        </span>
      </div>
    )
  if (
    start?.status !== "ready" ||
    sameRevision(start.preview.headOid, revision)
  )
    return null
  const { preview } = start
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-3 rounded-[14px] bg-surface px-5 py-4 shadow-[0_0_0_1px_var(--nv-line)]">
      <GitCommitHorizontalIcon
        aria-hidden="true"
        className="size-[18px] shrink-0 text-ink-muted"
        strokeWidth={1.75}
      />
      <span className="flex min-w-0 flex-auto flex-col gap-0.5">
        <span className="text-[15px] font-semibold text-pretty">
          New work on{" "}
          <code translate="no" className="font-mono text-[14px] wrap-anywhere">
            {preview.branch}
          </code>{" "}
          since {since}
        </span>
        <span translate="no" className="font-mono text-[12px] text-ink-muted">
          {short(revision)} → {short(preview.headOid)}
        </span>
      </span>
      {onStartReview && (
        <StartReviewButton
          onStartReview={onStartReview}
          initialState={
            start.failure !== undefined
              ? { status: "failed", message: start.failure }
              : undefined
          }
        />
      )}
    </div>
  )
}
