import { createFileRoute } from "@tanstack/react-router"
import { LineageSkeleton } from "@workspace/ui/neuve/states/skeletons"
import { LineagePage } from "@workspace/ui/neuve/states/pages"
import { loadCommit } from "@/server/review-loads"
import { validateChangesSearch } from "@/components/commit-id"
import { PENDING, RouteError } from "@/components/route-states"

/** What a commit asks of you. */
export const Route = createFileRoute("/changes/$commit")({
  // An invalid previous revision is dropped, not shown as an error.
  validateSearch: validateChangesSearch,
  loader: () => loadCommit(),
  head: () => ({ meta: [{ title: "What changed · Neuve" }] }),
  ...PENDING,
  pendingComponent: LineageSkeleton,
  errorComponent: RouteError,
  component: ChangesRoute,
})

function ChangesRoute() {
  return <LineagePage load={Route.useLoaderData()} back={{ to: "reviews" }} />
}
