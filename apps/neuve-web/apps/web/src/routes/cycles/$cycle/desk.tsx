import { createFileRoute, redirect } from "@tanstack/react-router"
import { Ulid } from "@neuve/records-schema"

import { ReturnSearch } from "@/components/return-search"
import { loadCycleEntry } from "@/server/review-cycle"

/**
 * A review cycle's review desk (decision 12.23: the card's second link), at
 * `/cycles/<cycle>/desk` under the app's base: across all the cycle's
 * batches, its first human-required unit that waits, else its first unit
 * that waits, else its first unit (`cycleEntry`). A cycle with no unit to
 * open yet shows the cycle's own address.
 */
export const Route = createFileRoute("/cycles/$cycle/desk")({
  // The coding workspace's return address goes on with the redirect.
  validateSearch: ReturnSearch,
  loaderDeps: ({ search }) => ({ returnTo: search.returnTo }),
  loader: async ({ params, deps }) => {
    const unitId = Ulid.safeParse(params.cycle).success
      ? await loadCycleEntry({ data: { cycle: params.cycle } })
      : undefined
    if (unitId)
      throw redirect({
        to: "/review/$unitId",
        params: { unitId },
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
