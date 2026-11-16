/* ─────────────────────────────────────────────────────────
 * ANIMATION STORYBOARD — Reviews page
 *
 *    0ms   a page of the list opens (a page number, Previous or Next, or
 *          the filter): the ten rows fade in where they stand (contentFade
 *          160ms); the list stays one page tall and the page returns to the
 *          list's top under its bar
 *    0ms   the Open next action hovered (real pointer hover): tone shift
 *          (surfaceTone); its arrow nudges (nudge)
 *
 * Nothing moves on first paint. Reduced motion: the fade only (reduced
 * 150ms, from globals.css); no tone transition.
 * ───────────────────────────────────────────────────────── */

import { Provider } from "jotai"
import { MotionConfig } from "motion/react"
import { ArrowRightIcon, CircleAlertIcon } from "lucide-react"

import {
  Pagination,
  PaginationContent,
  PaginationDisabled,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationNextContent,
  PaginationPreviousContent,
  pageWindow,
} from "@workspace/ui/components/pagination"
import { cn } from "@workspace/ui/lib/utils"
import { NewWorkNotice } from "@workspace/ui/neuve/batch-overview/new-work-notice"
import { ReviewRow } from "@workspace/ui/neuve/reviews/review-row"
import { AppHeader } from "@workspace/ui/neuve/shared/app-header"
import { NeuveLink } from "@workspace/ui/neuve/shared/nav-link"
import type { NeuveDestination } from "@workspace/ui/neuve/shared/nav-link"
import { Segmented } from "@workspace/ui/neuve/shared/segmented"
import { regionTransition } from "@workspace/ui/neuve/shared/view-transitions"
import type { ReviewStart } from "@workspace/ui/neuve/states/review-start"
import { StartReviewButton } from "@workspace/ui/neuve/states/start-review"
import type { StartReviewHandler } from "@workspace/ui/neuve/states/start-review"
import type {
  ReviewSummary,
  ReviewsData,
  ReviewsFilter,
} from "@workspace/ui/neuve/types"

const STROKE = 1.75

const plural = (count: number, one: string, many: string) =>
  `${count} ${count === 1 ? one : many}`

export interface DayGroup<T extends { at: string } = ReviewSummary> {
  label: string
  reviews: Array<{ review: T; time: string }>
}

/**
 * The page's reviews under their days, in the reader's time zone: Today,
 * Yesterday, then the weekday and date (with the year once it isn't this
 * one). Each review keeps its run's time of day.
 */
export function dayGroups<T extends { at: string } = ReviewSummary>(
  reviews: ReadonlyArray<T>,
  now: Date,
  timeZone?: string
): Array<DayGroup<T>> {
  const key = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
  const time = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
  })
  const today = key.format(now)
  const yesterday = key.format(new Date(now.getTime() - 86_400_000))
  const year = now.toLocaleString("en-GB", { timeZone, year: "numeric" })
  const groups: Array<DayGroup<T>> = []
  for (const review of reviews) {
    const at = new Date(review.at)
    const day = key.format(at)
    const label =
      day === today
        ? "Today"
        : day === yesterday
          ? "Yesterday"
          : new Intl.DateTimeFormat("en-GB", {
              timeZone,
              weekday: "long",
              day: "numeric",
              month: "long",
              ...(at.toLocaleString("en-GB", { timeZone, year: "numeric" }) ===
              year
                ? {}
                : { year: "numeric" as const }),
            }).format(at)
    const last = groups.at(-1)
    const entry = { review, time: time.format(at) }
    if (last?.label === label) last.reviews.push(entry)
    else groups.push({ label, reviews: [entry] })
  }
  return groups
}

export function WaitingPanel({ data }: { data: Pick<ReviewsData, "waiting"> }) {
  const { units, reviews, nextUnitId } = data.waiting
  return (
    <section
      aria-label="Waiting on you"
      className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4 rounded-[16px] bg-surface p-5 shadow-[0_0_0_1px_var(--nv-line)] max-[600px]:p-4"
    >
      <div className="flex min-w-0 flex-col gap-1">
        <p className="m-0 text-[22px] leading-7 font-semibold tracking-[-0.02em] text-pretty">
          {units > 0
            ? `${plural(units, "unit waits", "units wait")} on you`
            : "Nothing waits on you"}
        </p>
        {units > 0 && (
          <p className="m-0 text-[13px] text-ink-muted">
            in {plural(reviews, "review", "reviews")}
          </p>
        )}
      </div>
      {nextUnitId && (
        <NeuveLink
          destination={{ to: "unit", unitId: nextUnitId }}
          className="group/cta inline-flex h-11 shrink-0 items-center gap-2.5 rounded-[10px] bg-ink px-[18px] text-sm font-medium text-paper no-underline transition-colors duration-surface-tone ease-standard hover:bg-ink/90 hover:text-paper motion-reduce:transition-none"
        >
          Open next
          <ArrowRightIcon
            aria-hidden="true"
            className="size-[15px] transition-transform duration-nudge ease-ios-out group-hover/cta:translate-x-(--nv-offset-nudge) motion-reduce:transition-none"
            strokeWidth={STROKE}
          />
        </NeuveLink>
      )}
    </section>
  )
}

/**
 * The newest review failed: Start a review again, in its failed state, with
 * what went wrong under it.
 */
export function FailedStartNotice({
  start,
  onStartReview,
}: {
  start: Extract<ReviewStart, { status: "ready" }>
  onStartReview: StartReviewHandler
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-3 rounded-[14px] bg-surface px-5 py-4 shadow-[0_0_0_1px_var(--nv-line)]">
      <CircleAlertIcon
        aria-hidden="true"
        className="size-[18px] shrink-0 text-warn"
        strokeWidth={STROKE}
      />
      <span className="flex min-w-0 flex-auto flex-col gap-0.5">
        <span className="text-[15px] font-semibold text-pretty">
          The newest review of{" "}
          <code translate="no" className="font-mono text-[14px] wrap-anywhere">
            {start.preview.branch}
          </code>{" "}
          failed
        </span>
        <span translate="no" className="font-mono text-[12px] text-ink-muted">
          {start.preview.headOid.slice(0, 7)}
        </span>
      </span>
      <StartReviewButton
        onStartReview={onStartReview}
        initialState={{ status: "failed", message: start.failure ?? "" }}
      />
    </div>
  )
}

/** The list's pages: the Reviews page's, and the home page's. */
type Paged = Pick<ReviewsData, "filter" | "page" | "pageSize" | "total">

function pageOf(data: Paged, page: number): NeuveDestination {
  return {
    to: "reviews",
    page,
    filter: data.filter === "waiting" ? "waiting" : undefined,
    section: "reviews",
  }
}

/**
 * shadcn's Pagination for the list: Previous, the pages around this one
 * (an ellipsis between far pages), Next. At phone width the numbers give
 * way to "Page 2 of 5" between the arrows.
 */
export function ReviewsPagination({ data }: { data: Paged }) {
  const count = Math.max(1, Math.ceil(data.total / data.pageSize))
  if (count < 2) return null
  const { page } = data
  return (
    <Pagination aria-label="Pages of reviews">
      <PaginationContent>
        <PaginationItem>
          {page > 1 ? (
            <PaginationLink
              asChild
              className="pr-3 pl-2 max-[760px]:size-11 max-[760px]:p-0 max-[760px]:[&_[data-slot=pagination-label]]:hidden"
            >
              <NeuveLink
                destination={pageOf(data, page - 1)}
                aria-label="Previous page"
              >
                <PaginationPreviousContent />
              </NeuveLink>
            </PaginationLink>
          ) : (
            <PaginationDisabled className="pr-3 pl-2 max-[760px]:size-11 max-[760px]:p-0 max-[760px]:[&_[data-slot=pagination-label]]:hidden">
              <PaginationPreviousContent />
            </PaginationDisabled>
          )}
        </PaginationItem>
        {pageWindow(page, count).map((n, index) => (
          <PaginationItem
            key={n ?? `gap-${index}`}
            className="max-[760px]:hidden"
          >
            {n === null ? (
              <PaginationEllipsis />
            ) : (
              <PaginationLink asChild isActive={n === page}>
                <NeuveLink
                  destination={pageOf(data, n)}
                  aria-label={`Page ${n}`}
                >
                  {n}
                </NeuveLink>
              </PaginationLink>
            )}
          </PaginationItem>
        ))}
        <PaginationItem className="hidden px-2 text-[13px] whitespace-nowrap text-ink-2 tabular-nums max-[760px]:block">
          Page {page} of {count}
        </PaginationItem>
        <PaginationItem>
          {page < count ? (
            <PaginationLink
              asChild
              className="pr-2 pl-3 max-[760px]:size-11 max-[760px]:p-0 max-[760px]:[&_[data-slot=pagination-label]]:hidden"
            >
              <NeuveLink
                destination={pageOf(data, page + 1)}
                aria-label="Next page"
              >
                <PaginationNextContent />
              </NeuveLink>
            </PaginationLink>
          ) : (
            <PaginationDisabled className="pr-2 pl-3 max-[760px]:size-11 max-[760px]:p-0 max-[760px]:[&_[data-slot=pagination-label]]:hidden">
              <PaginationNextContent />
            </PaginationDisabled>
          )}
        </PaginationItem>
      </PaginationContent>
    </Pagination>
  )
}

export interface ReviewsScreenProps {
  data: ReviewsData
  /** Shows the list's other filter; the host moves to it (the page's address). */
  onFilterChange?: (filter: ReviewsFilter) => void
  /** What "Start a review" would review now, once the branch moved on. */
  start?: ReviewStart
  onStartReview?: StartReviewHandler
  /** The day groups' "now" and time zone (stories pin them; the page reads the clock). */
  now?: Date
  timeZone?: string
}

function Reviews({
  data,
  onFilterChange,
  start,
  onStartReview,
  now = new Date(),
  timeZone,
}: ReviewsScreenProps) {
  const groups = dayGroups(data.reviews, now, timeZone)
  const first = (data.page - 1) * data.pageSize + 1
  const last = first + data.reviews.length - 1
  return (
    <div className="min-h-svh bg-paper font-sans text-sm text-ink">
      <AppHeader repo={data.repo} current="reviews" />
      <main className="mx-auto box-border flex max-w-[1180px] content-fade flex-col gap-10 px-6 pt-14 pb-24 max-[600px]:px-4">
        <section
          {...regionTransition("reviews-hero", 1)}
          className="flex flex-col gap-5"
        >
          <h1 className="m-0 text-[40px] leading-[46px] font-semibold tracking-[-0.03em] max-[600px]:text-[30px] max-[600px]:leading-9">
            Reviews
          </h1>
          {start?.status === "ready" &&
          start.failure !== undefined &&
          onStartReview ? (
            <FailedStartNotice start={start} onStartReview={onStartReview} />
          ) : (
            data.newestHead && (
              <NewWorkNotice
                start={start?.status === "ready" ? start : undefined}
                revision={data.newestHead}
                onStartReview={onStartReview}
                since="the newest review"
              />
            )
          )}
          <WaitingPanel data={data} />
        </section>
        <section
          {...regionTransition("reviews-list", 2)}
          id="reviews"
          aria-labelledby="reviews-heading"
          className="flex scroll-mt-0 flex-col gap-6"
        >
          {/* The list's bar stays in view while the list scrolls. */}
          <div className="sticky top-0 z-10 -my-3 flex flex-wrap items-center justify-between gap-3 bg-paper py-3">
            <h2
              id="reviews-heading"
              className="m-0 text-[22px] font-semibold tracking-[-0.02em]"
            >
              All reviews
            </h2>
            <Segmented
              label="Show"
              value={data.filter}
              onValueChange={onFilterChange}
              options={[
                { value: "all", label: "All", count: data.counts.all },
                {
                  value: "waiting",
                  label: "Waiting on you",
                  count: data.counts.waiting,
                },
              ]}
            />
          </div>
          {/* Keyed by page and filter: each page's rows fade in where they stand. */}
          <div
            key={`${data.filter}:${data.page}`}
            className="flex content-fade flex-col gap-6"
          >
            {groups.length === 0 && (
              <p className="m-0 text-ink-muted">
                {data.filter === "waiting"
                  ? "Nothing waits on you."
                  : "No reviews on this page."}
              </p>
            )}
            {groups.map((group) => (
              <section
                key={group.label}
                aria-label={group.label}
                className="flex flex-col gap-2.5"
              >
                <h3 className="m-0 font-mono text-[11px] font-normal tracking-[0.07em] text-ink-muted uppercase">
                  {group.label}
                </h3>
                <ol className="m-0 list-none overflow-hidden rounded-[14px] bg-surface p-0 shadow-[0_0_0_1px_var(--nv-line)] [&>li+li]:border-t [&>li+li]:border-line-2">
                  {group.reviews.map(({ review, time }) => (
                    <li key={review.id}>
                      <ReviewRow review={review} time={time} />
                    </li>
                  ))}
                </ol>
              </section>
            ))}
          </div>
          <div
            className={cn("flex flex-wrap items-center justify-between gap-3")}
          >
            <span className="font-mono text-[12.5px] text-ink-muted tabular-nums">
              {data.total === 0
                ? "No reviews"
                : `${first}–${last} of ${plural(data.total, "review", "reviews")}`}
            </span>
            <ReviewsPagination data={data} />
          </div>
        </section>
      </main>
    </div>
  )
}

/**
 * Reviews — every review of the repository, newest run first, ten to a page:
 * what waits on the viewer across them and the way into the next unit, then
 * each review's range, time, state, units by lane, the viewer's decisions
 * on its human-required units and its batches.
 */
export function ReviewsScreen(props: ReviewsScreenProps) {
  return (
    <Provider>
      <MotionConfig reducedMotion="user">
        <Reviews {...props} />
      </MotionConfig>
    </Provider>
  )
}
