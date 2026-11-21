import { createServerFn } from "@tanstack/react-start"
import type {
  LiveChange,
  LiveMark,
} from "@workspace/ui/neuve/states/live-status"

import { currentMark } from "./live-events.server"

/**
 * A change as the BFF sends it (`live-events.server.ts`): the UI's
 * `LiveChange`, and, when a packet was published in a review that moved,
 * the earlier reviews whose work that review takes over by Records'
 * lineage (`takenOver`). Their batch and unit pages are the only other
 * pages a publication can change: their "Newer review" link and its one
 * announcement.
 */
export type PageChange =
  | "all"
  | (Exclude<LiveChange, "all"> & {
      /** Earlier reviews (cycle IDs) a review that published takes over; absent when none. */
      readonly takenOver?: ReadonlyArray<string>
    })

/** One mark of the stream as the BFF sends it. */
export interface PageEvent extends LiveMark {
  changed: PageChange
}

/**
 * Records' mark as the pages are loaded (M5 LV1): the root route reads it
 * before every page loader, so the app reloads exactly when the event
 * stream's mark moves past it.
 */
export const loadLiveMark = createServerFn({ method: "GET" }).handler(
  (): Promise<LiveMark> => currentMark()
)

/** The changes of two events in a row, as one: what moved across both. */
export const mergeChanges = (
  earlier: PageChange | null,
  later: PageChange
): PageChange => {
  if (earlier === null) return later
  if (earlier === "all" || later === "all") return "all"
  const takenOver = [
    ...new Set([...(earlier.takenOver ?? []), ...(later.takenOver ?? [])]),
  ]
  return {
    cycles: [...new Set([...earlier.cycles, ...later.cycles])],
    jobs: earlier.jobs || later.jobs,
    ...(takenOver.length > 0 ? { takenOver } : {}),
  }
}

/** The page on screen: its route, its address's parameters and what its loader returned. */
export interface PageMatch {
  readonly routeId: string
  readonly params: Readonly<Record<string, string | undefined>>
  readonly loaderData?: unknown
}

interface Batches {
  readonly pending?: number
}

/** Loader data that names its review: `/batch/$batchId`'s and `/review/$unitId`'s. */
interface NamedLoad {
  readonly cycleId?: string
  /** The overview's load. */
  readonly status?: string
  readonly data?: { readonly batches?: Batches }
  /** The desk's load, inside the unit page's. */
  readonly load?: {
    readonly status?: string
    readonly data?: { readonly batches?: Batches }
  }
}

/** The review a batch or unit page shows, and whether its batches are still to come. */
const shownReview = (loaderData: unknown) => {
  if (typeof loaderData !== "object" || loaderData === null) return undefined
  const named = loaderData as NamedLoad
  if (typeof named.cycleId !== "string") return undefined
  const batches = named.load?.data?.batches ?? named.data?.batches
  return { cycleId: named.cycleId, pending: (batches?.pending ?? 0) > 0 }
}

/**
 * Whether a change the stream sent can concern the page on screen, so the
 * page reloads: when in doubt, it does, since a missed reload leaves a stale
 * page and an extra one costs little.
 *
 * - `"all"` concerns every page.
 * - The Reviews list and the start page (`/`) show every review and the
 *   running state of "Start a review": every change concerns them. So does
 *   a review's own address (`/cycles/$cycle`), the list scoped to it: a
 *   later review can take its work over.
 * - A review's desk address (`/cycles/$cycle/desk`) waits for it to open:
 *   a change of its cycle or of the jobs.
 * - A batch or unit page: a change of the review its loader data names; a
 *   packet published in a later review whose lineage names it (`takenOver`),
 *   which can give the page its "Newer review" link; or the jobs while
 *   batches of it are still to come (the header says whether a run of it is
 *   going). A page that names no review (nothing opened, or the
 *   unknown-unit state) reloads for every change, since a batch may arrive.
 *   So a page of an older review reloads for its own review's events and
 *   for each publication in a review that takes its work over, never for
 *   another review's decisions, comments or job ticks.
 * - Any other page reloads for every change.
 */
export function pageConcerned(
  change: PageChange,
  page: PageMatch | undefined
): boolean {
  if (change === "all" || page === undefined) return true
  switch (page.routeId) {
    case "/":
    case "/cycles/$cycle/":
      return true
    case "/cycles/$cycle/desk": {
      const cycle = page.params.cycle
      return change.jobs || cycle === undefined || change.cycles.includes(cycle)
    }
    case "/batch/$batchId":
    case "/review/$unitId": {
      const review = shownReview(page.loaderData)
      if (review === undefined) return true
      return (
        change.cycles.includes(review.cycleId) ||
        (change.takenOver?.includes(review.cycleId) ?? false) ||
        (change.jobs && review.pending)
      )
    }
    default:
      return true
  }
}
