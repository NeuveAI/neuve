import { createFileRoute, redirect } from "@tanstack/react-router"
import { Ulid } from "@neuve/records-schema"

import { ReturnSearch } from "@/components/return-search"
import { loadReviewCycle } from "@/server/review-cycle"
import { loadOverview } from "@/server/review-loads"

/**
 * A review cycle's review desk (decision 12.23: the card's second link), at
 * `/cycles/<cycle>/desk` under the app's base: the unit its first batch's
 * overview starts the review at. A cycle with no batch to open yet shows
 * the cycle's own page.
 */
export const Route = createFileRoute("/cycles/$cycle/desk")({
  // The coding workspace's return address goes on with the redirect.
  validateSearch: ReturnSearch,
  loaderDeps: ({ search }) => ({ returnTo: search.returnTo }),
  loader: async ({ params, deps }) => {
    const cycle = Ulid.safeParse(params.cycle).success
      ? await loadReviewCycle({ data: { cycle: params.cycle } })
      : undefined
    const first = cycle?.batches[0]
    const overview = first
      ? await loadOverview({ data: { batchId: first.id } })
      : undefined
    if (overview?.status === "ready")
      throw redirect({
        to: "/review/$unitId",
        params: { unitId: overview.data.firstUnitId },
        search: { returnTo: deps.returnTo },
        replace: true,
      })
    throw redirect({
      to: "/cycles/$cycle",
      params: { cycle: params.cycle },
      search: { returnTo: deps.returnTo },
      replace: true,
    })
  },
})
