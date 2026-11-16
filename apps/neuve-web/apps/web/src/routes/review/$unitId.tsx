import { createFileRoute, notFound, redirect } from "@tanstack/react-router"

import { ReviewDeskSkeleton } from "@workspace/ui/neuve/states/skeletons"
import { ReviewDeskPage } from "@workspace/ui/neuve/states/pages"
import { NewerReviewProvider } from "@workspace/ui/neuve/shared/app-header"
import type { UnknownUnitData } from "@workspace/ui/neuve/types"
import { loadDesk } from "@/server/review-loads"
import { loaderKeepsPage } from "@/components/live-reload"

import { liveCommentRepository, useLiveDeskSinks } from "@/components/live-desk"
import { useLiveFeedbackSink } from "@/components/live-feedback"
import { recordedDecision } from "@/components/recorded-decision"
import { usePendingUnitId } from "@/components/pending-unit"
import { PENDING, RouteError, UnitNotFound } from "@/components/route-states"

/** A review unit of a standing packet, with the dock recording to Records. */
export const Route = createFileRoute("/review/$unitId")({
  loader: async ({ params, cause }) => {
    // Only the live reload keeps a unit a newer review replaced in place
    // (`loaderKeepsPage`); every other load follows its work.
    const stay = loaderKeepsPage(cause)
    const live = await loadDesk({ data: { unitId: params.unitId, stay } })
    // An old unit link: the work is in a later unit now (its lineage).
    if (live.successor)
      throw redirect({
        to: "/review/$unitId",
        params: { unitId: live.successor.unitId },
        replace: true,
      })
    if (live.load.status === "missing") {
      const missing: UnknownUnitData = {
        reason: "unknown-unit",
        unitId: live.load.unitId,
        batch: live.load.batch,
      }
      throw notFound({ data: missing })
    }
    return live
  },
  head: ({ loaderData }) => ({
    meta: [
      {
        title: `${loaderData?.load.status === "ready" ? loaderData.load.data.unit.title : "Review unit"} · Neuve`,
      },
    ],
  }),
  ...PENDING,
  pendingComponent: ReviewDeskSkeleton,
  notFoundComponent: UnitNotFound,
  errorComponent: RouteError,
  component: ReviewDeskRoute,
})

function ReviewDeskRoute() {
  const { unitId } = Route.useParams()
  const pendingUnitId = usePendingUnitId()
  const live = Route.useLoaderData()
  const sinks = useLiveDeskSinks(
    unitId,
    live.load.status === "ready" ? live.load.data : undefined
  )
  const feedbackSink = useLiveFeedbackSink()
  return (
    // The header says when a newer review replaced this unit's (the desk
    // screen hands it only the batches).
    <NewerReviewProvider
      newer={live.load.status === "ready" ? live.load.data.newer : undefined}
    >
      <ReviewDeskPage
        load={live.load}
        pendingUnitId={pendingUnitId}
        commentRepository={liveCommentRepository}
        feedbackSink={feedbackSink}
        {...sinks}
        {...recordedDecision(live.load)}
      />
    </NewerReviewProvider>
  )
}
