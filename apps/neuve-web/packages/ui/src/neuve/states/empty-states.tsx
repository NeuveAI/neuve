import {
  CheckCheckIcon,
  CompassIcon,
  GitCommitHorizontalIcon,
  SearchXIcon,
} from "lucide-react"

import { EmptyPage } from "@workspace/ui/neuve/states/empty-page"
import { StartReviewButton } from "@workspace/ui/neuve/states/start-review"
import type {
  StartReviewHandler,
  StartReviewState,
} from "@workspace/ui/neuve/states/start-review"
import { RunningReviewEmpty } from "@workspace/ui/neuve/states/running-review"
import type { ReviewStart } from "@workspace/ui/neuve/states/review-start"
import type { DeskBatchContext } from "@workspace/ui/neuve/types"

/*
 * Empty states (vocabulary.md terms: review batch, review unit, revision,
 * review lane). Less is more: one line of why, one action at most.
 */

/**
 * No review batch yet. On the batch overview it offers "Start a review": a
 * button whose handler asks the assigned harness to register a batch (the
 * backend wires it; the mock pages use a stand-in). Elsewhere (desk,
 * lineage) it only says why there is nothing to show.
 *
 * With `start` (the live overview, M5 ST2–ST4) it shows the branch it will
 * review against its base before the press, a refusal or the last review's
 * failure in the button's failed state, and the running state while a
 * requested review works.
 */
export function NoBatchEmpty({
  onStartReview,
  startReviewState,
  start,
  focusTitle,
}: {
  onStartReview?: StartReviewHandler
  /** Seeds the button's state (stories). */
  startReviewState?: StartReviewState
  /** What the host loaded for "Start a review". */
  start?: ReviewStart
  /** The reader just pressed "Start a review": focus the running state's heading. */
  focusTitle?: boolean
}) {
  if (start?.status === "running")
    return <RunningReviewEmpty run={start.run} focusTitle={focusTitle} />
  if (!onStartReview) {
    return (
      <EmptyPage icon={GitCommitHorizontalIcon} title="No review batch yet">
        A review batch appears when a commit is registered for review.
      </EmptyPage>
    )
  }
  const seeded: StartReviewState | undefined =
    start?.status === "refused"
      ? { status: "failed", message: start.message }
      : start?.status === "ready" && start.failure !== undefined
        ? { status: "failed", message: start.failure }
        : startReviewState
  return (
    <EmptyPage
      icon={GitCommitHorizontalIcon}
      title="No review batch yet"
      actionSlot={
        <StartReviewButton
          onStartReview={onStartReview}
          initialState={seeded}
        />
      }
    >
      {start?.status === "ready" ? (
        <>
          <code translate="no" className="wrap-anywhere">
            {start.preview.branch}
          </code>{" "}
          · {start.preview.ahead}{" "}
          {start.preview.ahead === 1 ? "commit" : "commits"} ahead of{" "}
          <code translate="no" className="wrap-anywhere">
            {start.preview.base}
          </code>
          <br />
          on <code translate="no">{start.preview.route}</code>
        </>
      ) : start?.status === "refused" ? (
        "Neuve reviews the checked-out branch against its base."
      ) : (
        "Pick a branch and Neuve gathers what needs your decision."
      )}
    </EmptyPage>
  )
}

/** (a) Nothing in this batch needs a human decision. */
export function NoDecisionEmpty({ batch }: { batch: DeskBatchContext }) {
  const elsewhere = batch.elsewhere.reduce((sum, lane) => sum + lane.count, 0)
  return (
    <EmptyPage
      batch={batch}
      icon={CheckCheckIcon}
      title="No units need your decision"
      action={{
        label: "Open other review lanes",
        destination: {
          to: "overview",
          batchId: batch.batchId,
          section: "lanes",
        },
      }}
    >
      {elsewhere} review units in {batch.batchTitle} are assigned to other
      lanes. Open a unit to see its review status.
    </EmptyPage>
  )
}

/** (b) The unit isn't part of this revision (regrouped or never existed). */
export function UnknownUnitEmpty({
  unitId,
  batch,
}: {
  unitId: string
  batch?: DeskBatchContext
}) {
  return (
    <EmptyPage
      batch={batch}
      icon={SearchXIcon}
      title="This unit isn’t in this revision"
      action={
        batch?.batchId
          ? {
              label: "Batch overview",
              destination: { to: "overview", batchId: batch.batchId },
            }
          : { label: "Reviews", destination: { to: "reviews" } }
      }
    >
      <code>{unitId}</code> isn’t a review unit
      {batch ? (
        <>
          {" "}
          of <code>{batch.revision}</code>
        </>
      ) : null}
      . Units are regrouped when a new commit is registered.
    </EmptyPage>
  )
}

/**
 * `/changes/<sha>` that names no registered revision and is not the
 * submitted branch's observed head (round 3, item 16): a plain not-found,
 * never the route's validation pattern.
 */
export function UnknownCommitEmpty({
  commit,
  candidates,
}: {
  commit: string
  /** Several revisions start with it: a longer id resolves. */
  candidates?: number
}) {
  const shown = commit.length > 24 ? `${commit.slice(0, 24)}…` : commit
  return (
    <EmptyPage
      icon={SearchXIcon}
      title={
        candidates
          ? "This commit id is ambiguous"
          : "This commit isn’t in the review"
      }
      action={{ label: "Reviews", destination: { to: "reviews" } }}
    >
      <code className="break-all" title={commit}>
        {shown}
      </code>{" "}
      {candidates
        ? `matches ${candidates} revisions. Use more characters.`
        : "doesn’t match a registered revision or the submitted branch."}
    </EmptyPage>
  )
}

/** No page at this address. */
export function NotFoundEmpty() {
  return (
    <EmptyPage
      icon={CompassIcon}
      title="Nothing at this address"
      action={{ label: "Reviews", destination: { to: "reviews" } }}
    >
      There is no page here.
    </EmptyPage>
  )
}
