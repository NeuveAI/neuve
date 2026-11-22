import { createFileRoute, useNavigate, useRouter } from "@tanstack/react-router"
import { atom, useAtomValue, useSetAtom } from "jotai"
import { z } from "zod"
import { ReviewsSkeleton } from "@workspace/ui/neuve/states/skeletons"
import { HomePage } from "@workspace/ui/neuve/home/home-screen"
import type { ReviewStart } from "@workspace/ui/neuve/states/review-start"
import type { StartReviewHandler } from "@workspace/ui/neuve/states/start-review"
import type { ReviewsFilter } from "@workspace/ui/neuve/types"
import { PENDING, RouteError } from "@/components/route-states"
import { loadHome, requestClear } from "@/server/home-load"
import { nextStart } from "@/components/next-start"
import { loadMovedPast } from "@/server/branch-moved"
import { loadStart, requestStart } from "@/server/start-review"

/**
 * The page and filter in the address, so a page of the list can be shared
 * and the back button returns to it. Anything else reads as the first page
 * of "Waiting on you"; `filter=all` lists every review, and `cycle` that
 * one review.
 */
const ReviewsSearch = z.object({
  returnTo: z.string().max(8192).optional().catch(undefined),
  cycle: z
    .string()
    .regex(/^[0-9A-HJKMNP-TV-Z]{26}$/)
    .optional(),
  page: z.coerce.number().int().min(1).max(10_000).optional().catch(undefined),
  filter: z.enum(["all"]).optional().catch(undefined),
})

/**
 * The home page: "Waiting on you" (the reviews that still need a person,
 * human-required work first), or every review of the repository, newest run
 * first; each with its batches and their batch digests, lanes and what waits
 * on the reader; nothing is opened for them. With
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
    filter: search.filter ?? "waiting",
  }),
  loader: async ({ deps }) => {
    if (deps.cycle)
      return {
        load: await loadHome({
          data: { page: 1, filter: "all", cycle: deps.cycle },
        }),
        start: undefined,
      }
    // The list and the branch's state are read side by side.
    const [load, start] = await Promise.all([
      loadHome({ data: { page: deps.page, filter: deps.filter } }),
      loadStart().catch(() => undefined),
    ])
    if (load.status === "empty")
      return {
        load,
        start: start ?? (await loadStart()),
      }
    return {
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
  const { load, start } = result
  const navigate = useNavigate({ from: "/" })
  const onStartReview = useStartHandler(start)
  const started = useAtomValue(startedAtom)
  const router = useRouter()
  return (
    <HomePage
      load={load}
      start={start}
      onStartReview={onStartReview}
      focusTitle={started}
      // "Clear" or its undo, then the list as Records now holds it.
      onClear={async (restore) => {
        try {
          await requestClear({ data: { restore } })
        } finally {
          await router.invalidate()
        }
      }}
      // A new filter starts at its first page, at the top of the list.
      onFilterChange={(filter) =>
        void navigate({
          search: {
            filter: filter === "all" ? "all" : undefined,
            returnTo,
          },
          hash: "reviews",
        })
      }
    />
  )
}
