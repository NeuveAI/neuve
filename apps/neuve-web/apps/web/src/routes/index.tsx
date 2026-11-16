import { loadReviewCycle } from "@/server/review-cycle"
import { ReviewCycle } from "@/components/review-cycle"
import { createFileRoute, useNavigate, useRouter } from "@tanstack/react-router"
import { atom, useAtomValue, useSetAtom } from "jotai"
import { z } from "zod"
import { ReviewsSkeleton } from "@workspace/ui/neuve/states/skeletons"
import { HomePage } from "@workspace/ui/neuve/home/home-screen"
import type { ReviewStart } from "@workspace/ui/neuve/states/review-start"
import type { StartReviewHandler } from "@workspace/ui/neuve/states/start-review"
import type { ReviewsFilter } from "@workspace/ui/neuve/types"
import { PENDING, RouteError } from "@/components/route-states"
import { loadHome } from "@/server/home-load"
import { nextStart } from "@/components/next-start"
import { loadMovedPast } from "@/server/branch-moved"
import { loadStart, requestStart } from "@/server/start-review"

/**
 * The page and filter in the address, so a page of the list can be shared
 * and the back button returns to it. Anything else reads as the first page
 * of every review.
 */
const ReviewsSearch = z.object({
  returnTo: z.string().max(8192).optional().catch(undefined),
  cycle: z
    .string()
    .regex(/^[0-9A-HJKMNP-TV-Z]{26}$/)
    .optional(),
  page: z.coerce.number().int().min(1).max(10_000).optional().catch(undefined),
  filter: z.enum(["waiting"]).optional().catch(undefined),
})

/**
 * The home page: every review of the repository, newest run first, each with
 * its batches and their batch digests, lanes and what waits on the reader;
 * nothing is opened for them. With
 * none, "Start a review" (ST1–ST4): the branch it would review, or the review
 * it started while it runs; the review arrives through the web events. With
 * reviews, the same start, offered once the branch has moved past the newest
 * finished review's head (10.103), or again after the newest review failed;
 * it shows nothing if git can't say where the branch is.
 */
export const Route = createFileRoute("/")({
  validateSearch: ReviewsSearch,
  loaderDeps: ({
    search,
  }): { page: number; filter: ReviewsFilter; cycle?: string } => ({
    cycle: search.cycle,
    page: search.page ?? 1,
    filter: search.filter ?? "all",
  }),
  loader: async ({ deps }) => {
    if (deps.cycle)
      return {
        kind: "cycle" as const,
        cycle: await loadReviewCycle({ data: { cycle: deps.cycle } }),
      }
    // The list and the branch's state are read side by side.
    const [load, start] = await Promise.all([
      loadHome({ data: { page: deps.page, filter: deps.filter } }),
      loadStart().catch(() => undefined),
    ])
    if (load.status === "empty")
      return {
        kind: "list" as const,
        load,
        start: start ?? (await loadStart()),
      }
    return {
      kind: "list" as const,
      load,
      start: await nextStart(load.data.newestHead, start, (reviewed, head) =>
        loadMovedPast({ data: { reviewed, head } })
      ),
    }
  },
  head: () => ({ meta: [{ title: "Reviews · Neuve" }] }),
  // A new page or filter keeps the list on screen until the next one is
  // read; the skeleton shows only for a load that takes a second or more.
  ...PENDING,
  pendingMs: 1000,
  pendingComponent: ReviewsSkeleton,
  errorComponent: RouteError,
  component: ReviewsRoute,
})

/** The reader pressed "Start a review" in this tab: the running state's heading takes focus. */
const startedAtom = atom(false)

/**
 * The press: request the shown range, then reload so the running state
 * replaces the button and its heading takes focus. A refusal shows in the button's failed state; the
 * reload brings what the branch shows now.
 */
function useStartHandler(
  start: ReviewStart | undefined
): StartReviewHandler | undefined {
  const router = useRouter()
  const setStarted = useSetAtom(startedAtom)
  if (start === undefined || start.status === "running") return undefined
  if (start.status === "refused")
    return async () => {
      await router.invalidate()
      throw new Error(start.message)
    }
  return async () => {
    try {
      await requestStart({
        data: {
          head: start.preview.headOid,
          mergeBase: start.preview.mergeBase,
        },
      })
    } catch (error) {
      void router.invalidate()
      throw error
    }
    setStarted(true)
    await router.invalidate()
  }
}

function ReviewsRoute() {
  const result = Route.useLoaderData()
  const { returnTo } = Route.useSearch()
  const start = result.kind === "list" ? result.start : undefined
  const navigate = useNavigate({ from: "/" })
  const onStartReview = useStartHandler(start)
  const started = useAtomValue(startedAtom)
  if (result.kind === "cycle") return <ReviewCycle cycle={result.cycle} />
  const { load } = result
  return (
    <HomePage
      load={load}
      start={start}
      onStartReview={onStartReview}
      focusTitle={started}
      // A new filter starts at its first page, at the top of the list.
      onFilterChange={(filter) =>
        void navigate({
          search: {
            filter: filter === "waiting" ? "waiting" : undefined,
            returnTo,
          },
          hash: "reviews",
        })
      }
    />
  )
}
