import { createFileRoute, notFound, useNavigate } from "@tanstack/react-router"
import { Ulid } from "@neuve/records-schema"
import { HomePage } from "@workspace/ui/neuve/home/home-screen"
import { ReviewsSkeleton } from "@workspace/ui/neuve/states/skeletons"

import { ReturnSearch } from "@/components/return-search"
import { PENDING, RouteError } from "@/components/route-states"
import { loadHome } from "@/server/home-load"

/**
 * A review cycle's own address (decision 12.23: a finished review card
 * opens it first), the one Ace's review cards link to:
 * `/review/<project>/cycles/<cycle>` under Ace, `/cycles/<cycle>` on the
 * app's own address. It is the home list scoped to that one review: every
 * batch with its lanes and what waits, the review's lane counts across all
 * of them, and "Open next" on its first human-required unit that waits. The
 * live stream reloads it as Records moves.
 */
export const Route = createFileRoute("/cycles/$cycle/")({
  validateSearch: ReturnSearch,
  loader: async ({ params }) => {
    if (!Ulid.safeParse(params.cycle).success) throw notFound()
    const load = await loadHome({
      data: { page: 1, filter: "all", cycle: params.cycle },
    })
    // A cycle Records doesn't hold here is not found, as any unknown address.
    if (load.status !== "ready" || load.data.reviews.length === 0)
      throw notFound()
    return load
  },
  head: () => ({ meta: [{ title: "Review · Neuve" }] }),
  ...PENDING,
  pendingMs: 1000,
  pendingComponent: ReviewsSkeleton,
  errorComponent: RouteError,
  component: CycleRoute,
})

function CycleRoute() {
  const { returnTo } = Route.useSearch()
  const navigate = useNavigate()
  return (
    <HomePage
      load={Route.useLoaderData()}
      // Either filter leaves the one review for the whole list.
      onFilterChange={(filter) =>
        void navigate({
          to: "/",
          search: { filter: filter === "all" ? "all" : undefined, returnTo },
          hash: "reviews",
        })
      }
    />
  )
}
