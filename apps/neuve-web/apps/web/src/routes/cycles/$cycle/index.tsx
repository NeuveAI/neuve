import { createFileRoute, redirect } from "@tanstack/react-router"
import { Ulid } from "@neuve/records-schema"

import { ReturnSearch } from "@/components/return-search"
import { ReviewCycle } from "@/components/review-cycle"
import { PENDING, RouteError } from "@/components/route-states"
import { loadReviewCycle } from "@/server/review-cycle"

/**
 * A review cycle's batch overview (decision 12.23: a finished review card
 * opens it first), at the address Ace's review cards link to:
 * `/review/<project>/cycles/<cycle>` under Ace, `/cycles/<cycle>` on the
 * app's own address. Once Records has published the cycle's batches it is
 * the first batch's overview; until then the cycle itself, which the live
 * stream reloads as Records moves.
 */
export const Route = createFileRoute("/cycles/$cycle/")({
  // The coding workspace's return address goes on with the redirect.
  validateSearch: ReturnSearch,
  loaderDeps: ({ search }) => ({ returnTo: search.returnTo }),
  loader: async ({ params, deps }) => {
    if (!Ulid.safeParse(params.cycle).success) return { cycle: undefined }
    const cycle = await loadReviewCycle({ data: { cycle: params.cycle } })
    const first = cycle?.batches[0]
    if (first)
      throw redirect({
        to: "/batch/$batchId",
        params: { batchId: first.id },
        search: { returnTo: deps.returnTo },
        replace: true,
      })
    return { cycle }
  },
  head: () => ({ meta: [{ title: "Review · Neuve" }] }),
  ...PENDING,
  errorComponent: RouteError,
  component: CycleRoute,
})

function CycleRoute() {
  return <ReviewCycle cycle={Route.useLoaderData().cycle} />
}
