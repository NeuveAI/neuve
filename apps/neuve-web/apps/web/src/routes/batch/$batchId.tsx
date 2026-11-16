import { createFileRoute, redirect } from "@tanstack/react-router"
import { BatchOverviewSkeleton } from "@workspace/ui/neuve/states/skeletons"
import { BatchOverviewPage } from "@workspace/ui/neuve/states/pages"
import { NewerReviewProvider } from "@workspace/ui/neuve/shared/app-header"
import { PENDING, RouteError } from "@/components/route-states"
import { loadOverview } from "@/server/review-loads"
import { loaderKeepsPage } from "@/components/live-reload"

/**
 * One batch of a standing packet, by its Records ID (RD3): a range can
 * produce several batches (4.10), and each has its own address until the
 * header moves between them.
 */
export const Route = createFileRoute("/batch/$batchId")({
  // Only the live reload keeps a batch a newer review replaced in place
  // (`loaderKeepsPage`); every other load follows its work.
  loader: async ({ params, cause }) => {
    const load = await loadOverview({
      data: { batchId: params.batchId, stay: loaderKeepsPage(cause) },
    })
    // A batch a newer review replaced, entered: the work is in that batch now.
    if (load.successor)
      throw redirect({
        to: "/batch/$batchId",
        params: { batchId: load.successor.batchId },
        replace: true,
      })
    return load
  },
  head: ({ loaderData }) => ({
    meta: [
      {
        title: `${loaderData?.status === "ready" ? loaderData.data.title : "Review batch"} · Neuve`,
      },
    ],
  }),
  ...PENDING,
  pendingComponent: BatchOverviewSkeleton,
  errorComponent: RouteError,
  component: BatchRoute,
})

function BatchRoute() {
  const load = Route.useLoaderData()
  return (
    <NewerReviewProvider
      newer={load.status === "ready" ? load.data.newer : undefined}
    >
      <BatchOverviewPage load={load} />
    </NewerReviewProvider>
  )
}
