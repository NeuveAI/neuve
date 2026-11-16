import { createFileRoute } from "@tanstack/react-router"

import { batchOverviewFixture } from "@workspace/ui/fixtures/review-batch.fixtures"
import { BatchOverviewSkeleton } from "@workspace/ui/neuve/states/skeletons"
import { BatchOverviewPage } from "@workspace/ui/neuve/states/pages"
import type { BatchOverviewLoad } from "@workspace/ui/neuve/types"

import { PENDING, RouteError } from "@/components/route-states"
import {
  mockDelay,
  ssrUnlessDelayed,
  validateMockSearch,
} from "@/mock/mock-search"

/** How long the mock "Start a review" takes before the batch appears. */
const MOCK_START_MS = 800

/** Sample batch overview (fixtures). `?delay=ms`, `?state=empty`. */
export const Route = createFileRoute("/mock/")({
  validateSearch: validateMockSearch,
  loaderDeps: ({ search }) => search,
  ssr: ssrUnlessDelayed,
  loader: async ({ deps, abortController }): Promise<BatchOverviewLoad> => {
    await mockDelay(deps.delay, abortController.signal)
    if (deps.state) return { status: "empty", reason: "no-batch" }
    return { status: "ready", data: batchOverviewFixture }
  },
  head: () => ({ meta: [{ title: "Review batch (sample) · Neuve" }] }),
  ...PENDING,
  pendingComponent: BatchOverviewSkeleton,
  errorComponent: RouteError,
  component: MockBatchOverviewRoute,
})

function MockBatchOverviewRoute() {
  const navigate = Route.useNavigate()
  // Mock stand-in for the harness call: "starts" for ~800ms, then opens the
  // sample batch with a view transition. Nothing is registered.
  const startMockReview = async () => {
    await new Promise((resolve) => setTimeout(resolve, MOCK_START_MS))
    await navigate({
      to: "/mock",
      search: {},
      viewTransition: { types: ["forward"] },
    })
  }
  return (
    <BatchOverviewPage
      load={Route.useLoaderData()}
      onStartReview={startMockReview}
    />
  )
}
