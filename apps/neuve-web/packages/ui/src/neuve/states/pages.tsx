import { BatchOverviewScreen } from "@workspace/ui/neuve/batch-overview/batch-overview-screen"
import { ReviewsScreen } from "@workspace/ui/neuve/reviews/reviews-screen"
import type { ReviewsScreenProps } from "@workspace/ui/neuve/reviews/reviews-screen"
import { CommitObservationScreen } from "@workspace/ui/neuve/cycle/commit-observation-screen"
import {
  LineageScreen,
  lineageViewer,
} from "@workspace/ui/neuve/cycle/lineage-screen"
import type { ReviewDeskScreenProps } from "@workspace/ui/neuve/review-desk/review-desk-screen"
import type { AgentConnector } from "@workspace/ui/neuve/agents/atoms"
import { ReviewDeskScreen } from "@workspace/ui/neuve/review-desk/review-desk-screen"
import {
  NoBatchEmpty,
  NoDecisionEmpty,
  UnknownUnitEmpty,
} from "@workspace/ui/neuve/states/empty-states"
import type { StartReviewHandler } from "@workspace/ui/neuve/states/start-review"
import type { ReviewStart } from "@workspace/ui/neuve/states/review-start"
import type { NeuveDestination } from "@workspace/ui/neuve/shared/nav-link"
import type {
  BatchOverviewLoad,
  CommitLineageLoad,
  ReviewDeskLoad,
  ReviewsLoad,
} from "@workspace/ui/neuve/types"

/*
 * Route pages: a loader result in, the screen or its empty state out. The
 * app's routes render these; a BFF loader can replace the fixture loaders
 * without touching them.
 */

export function BatchOverviewPage({
  load,
  onStartReview,
  start,
  focusTitle,
  agentConnector,
}: {
  load: BatchOverviewLoad
  /**
   * "Start a review" (host-provided handler): on the empty overview, and on a
   * batch once its branch has moved past the reviewed head.
   */
  onStartReview?: StartReviewHandler
  /** The branch it would review, or the review it started (live overview). */
  start?: ReviewStart
  /** The reader just pressed "Start a review": focus the running state's heading. */
  focusTitle?: boolean
  agentConnector?: AgentConnector
}) {
  if (load.status === "empty") {
    // Keyed by what it shows, so a new start view gets a fresh button state.
    return (
      <NoBatchEmpty
        key={startKey(start)}
        onStartReview={onStartReview}
        start={start}
        focusTitle={focusTitle}
      />
    )
  }
  return (
    <BatchOverviewScreen
      data={load.data}
      agentConnector={agentConnector}
      start={start}
      onStartReview={onStartReview}
    />
  )
}

/**
 * `/`: every review of the repository. With none yet, "Start a review" as
 * the empty overview offers it (and the review it started while it runs).
 */
export function ReviewsPage({
  load,
  start,
  onStartReview,
  focusTitle,
  ...screen
}: { load: ReviewsLoad; focusTitle?: boolean } & Omit<
  ReviewsScreenProps,
  "data"
>) {
  if (load.status === "empty")
    return (
      <NoBatchEmpty
        key={startKey(start)}
        onStartReview={onStartReview}
        start={start}
        focusTitle={focusTitle}
      />
    )
  return (
    <ReviewsScreen
      data={load.data}
      start={start}
      onStartReview={onStartReview}
      {...screen}
    />
  )
}

function startKey(start: ReviewStart | undefined): string {
  if (start === undefined) return "none"
  if (start.status === "running") return "running"
  if (start.status === "refused") return `refused:${start.message}`
  return `ready:${start.preview.headOid}:${start.preview.mergeBase}:${start.failure ?? ""}`
}

export function ReviewDeskPage({
  load,
  ...screen
}: { load: ReviewDeskLoad } & Omit<ReviewDeskScreenProps, "data">) {
  if (load.status === "ready") {
    // Keyed by unit so moving between units starts from a fresh desk state.
    return (
      <ReviewDeskScreen
        key={`${load.data.revision}:${load.data.unit.id}`}
        data={load.data}
        {...screen}
      />
    )
  }
  if (load.status === "missing")
    return <UnknownUnitEmpty unitId={load.unitId} batch={load.batch} />
  if (load.reason === "no-decision")
    return <NoDecisionEmpty batch={load.batch} />
  return <NoBatchEmpty />
}

export function LineagePage({
  load,
  back,
  agentConnector,
}: {
  load: CommitLineageLoad
  back: NeuveDestination
  agentConnector?: AgentConnector
}) {
  if (load.status === "empty") return <NoBatchEmpty />
  if (load.status === "observed" || load.status === "unavailable")
    return (
      <CommitObservationScreen
        load={load}
        back={back}
        agentConnector={agentConnector}
      />
    )
  return (
    <LineageScreen
      lineage={load.lineage}
      agents={load.agents}
      back={back}
      reviewer={load.reviewer ?? lineageViewer(load.lineage)}
    />
  )
}
