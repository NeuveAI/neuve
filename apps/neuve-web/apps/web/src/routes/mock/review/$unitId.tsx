import { createFileRoute, notFound } from "@tanstack/react-router"

import {
  deskBatchContextFixture,
  mockDeskFixtures,
  mockDeskVariants,
} from "@workspace/ui/fixtures/review-batch.fixtures"
import { ReviewDeskSkeleton } from "@workspace/ui/neuve/states/skeletons"
import { ReviewDeskPage } from "@workspace/ui/neuve/states/pages"
import type { ReviewDeskLoad, UnknownUnitData } from "@workspace/ui/neuve/types"

import { mockCommentRepository } from "@/components/mock-comments"
import { usePendingUnitId } from "@/components/pending-unit"
import { PENDING, RouteError, UnitNotFound } from "@/components/route-states"
import {
  mockDelay,
  ssrUnlessDelayed,
  validateMockSearch,
} from "@/mock/mock-search"

/**
 * Sample review desk (fixtures). `?delay=ms`; `?state=empty` → no units need
 * your decision; `?state=no-batch` → no review batch yet; `?variant=` → the
 * unit as one of its Storybook variants (`mockDeskVariants`); an unknown
 * unit id → the unit isn't in this revision.
 */
export const Route = createFileRoute("/mock/review/$unitId")({
  validateSearch: validateMockSearch,
  loaderDeps: ({ search }) => search,
  ssr: ssrUnlessDelayed,
  loader: async ({
    params,
    deps,
    abortController,
  }): Promise<ReviewDeskLoad> => {
    await mockDelay(deps.delay, abortController.signal)
    if (deps.state === "no-batch")
      return { status: "empty", reason: "no-batch" }
    if (deps.state === "empty") {
      return {
        status: "empty",
        reason: "no-decision",
        batch: deskBatchContextFixture,
      }
    }
    const variant =
      deps.variant === undefined ? undefined : mockDeskVariants[deps.variant]
    const data =
      variant?.unit.id === params.unitId
        ? variant
        : mockDeskFixtures.find((desk) => desk.unit.id === params.unitId)
    if (!data) {
      const missing: UnknownUnitData = {
        reason: "unknown-unit",
        unitId: params.unitId,
        batch: deskBatchContextFixture,
      }
      throw notFound({ data: missing })
    }
    return { status: "ready", data }
  },
  head: ({ loaderData }) => ({
    meta: [
      {
        title: `${loaderData?.status === "ready" ? loaderData.data.unit.title : "Review unit"} (sample) · Neuve`,
      },
    ],
  }),
  ...PENDING,
  pendingComponent: ReviewDeskSkeleton,
  notFoundComponent: UnitNotFound,
  errorComponent: RouteError,
  component: MockReviewDeskRoute,
})

function MockReviewDeskRoute() {
  const pendingUnitId = usePendingUnitId()
  return (
    <ReviewDeskPage
      load={Route.useLoaderData()}
      pendingUnitId={pendingUnitId}
      commentRepository={mockCommentRepository}
    />
  )
}
