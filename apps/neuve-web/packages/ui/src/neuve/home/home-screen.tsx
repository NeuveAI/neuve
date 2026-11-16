/* ─────────────────────────────────────────────────────────
 * ANIMATION STORYBOARD — Home page (`/`)
 *
 *    0ms   a page of the list opens (a page number, Previous or Next, or
 *          the filter): its reviews and their batches fade in where they
 *          stand (contentFade 160ms); the page returns to the list's top
 *          under its bar
 *    0ms   a batch card hovered: see the batch card's storyboard
 *  rest    a running review's mark turns (pendingSpin), static under
 *          reduced motion
 *
 * Nothing moves on first paint. Reduced motion: the fade only (reduced
 * 150ms, from globals.css).
 * ───────────────────────────────────────────────────────── */

import { Provider } from "jotai"
import { MotionConfig } from "motion/react"
import { LoaderCircleIcon } from "lucide-react"

import { cn } from "@workspace/ui/lib/utils"
import { NewWorkNotice } from "@workspace/ui/neuve/batch-overview/new-work-notice"
import { BatchCard } from "@workspace/ui/neuve/home/batch-card"
import type {
  HomeData,
  HomeLoad,
  HomeReview,
} from "@workspace/ui/neuve/home/home-data"
import { RunState } from "@workspace/ui/neuve/reviews/review-row"
import {
  FailedStartNotice,
  ReviewsPagination,
  WaitingPanel,
  dayGroups,
} from "@workspace/ui/neuve/reviews/reviews-screen"
import { AppHeader } from "@workspace/ui/neuve/shared/app-header"
import { Segmented } from "@workspace/ui/neuve/shared/segmented"
import { regionTransition } from "@workspace/ui/neuve/shared/view-transitions"
import { NoBatchEmpty } from "@workspace/ui/neuve/states/empty-states"
import type { ReviewStart } from "@workspace/ui/neuve/states/review-start"
import type { StartReviewHandler } from "@workspace/ui/neuve/states/start-review"
import type { ReviewsFilter } from "@workspace/ui/neuve/types"

const STROKE = 1.75

const plural = (count: number, one: string, many: string) =>
  `${count} ${count === 1 ? one : many}`

const Dot = () => (
  <span aria-hidden="true" className="text-faint">
    ·
  </span>
)

/** "3 batches", or "2 of 5 batches" while the review still publishes them. */
const batchCount = (review: HomeReview) => {
  const pending = review.pendingBatches ?? 0
  const shown = review.batches.length
  return pending > 0
    ? `${shown} of ${shown + pending} batches`
    : plural(shown, "batch", "batches")
}

/**
 * The batches a review hasn't published: "Reviewing 2 more batches" while
 * it runs, "2 batches not reviewed" once it stopped without them.
 */
function PendingBatches({ review }: { review: HomeReview }) {
  const pending = review.pendingBatches ?? 0
  if (pending === 0) return null
  const running = review.state === "running"
  return (
    <div className="flex min-h-[120px] items-center justify-center gap-2 rounded-[14px] border border-dashed border-line-strong p-5 text-[13.5px] text-ink-muted">
      {running && (
        <LoaderCircleIcon
          aria-hidden="true"
          strokeWidth={STROKE}
          className="size-3.5 motion-safe:animate-pending-spin"
        />
      )}
      {running
        ? `Reviewing ${plural(pending, "more batch", "more batches")}`
        : `${plural(pending, "batch", "batches")} not reviewed`}
    </div>
  )
}

/** A review with no batch yet: running, or stopped before it published one. */
function NoBatchYet({ review }: { review: HomeReview }) {
  return (
    <div className="flex flex-col gap-1 rounded-[14px] border border-dashed border-line-strong px-5 py-4">
      <span className="text-[15px] leading-[22px] font-semibold text-pretty text-ink-2">
        {review.title}
      </span>
      <span className="text-[13px] text-ink-muted">
        {review.state === "running"
          ? "Its batches appear here as the review publishes them."
          : "This review published no batch."}
      </span>
    </div>
  )
}

/**
 * One review: when it ran, its range, where its run stands and how many
 * batches it has, then each batch as a card. An older review says a newer
 * one replaced it, and its batches ask for nothing (14.33).
 */
function ReviewGroup({ review, time }: { review: HomeReview; time: string }) {
  const older = review.newer === true
  return (
    <section
      aria-label={`Review ${review.range}`}
      className="flex flex-col gap-3"
    >
      <p className="m-0 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] text-ink-muted">
        <span className="font-mono tabular-nums">{time}</span>
        <Dot />
        <span translate="no" className="font-mono">
          {review.range}
        </span>
        <Dot />
        <RunState state={review.state} />
        {review.batches.length > 0 && (
          <>
            <Dot />
            <span>{batchCount(review)}</span>
          </>
        )}
        {older && (
          <>
            <Dot />
            <span className="text-ink-2">Replaced by a newer review</span>
          </>
        )}
      </p>
      {review.batches.length === 0 && (review.pendingBatches ?? 0) === 0 ? (
        <NoBatchYet review={review} />
      ) : (
        <ul className="m-0 grid list-none grid-cols-2 gap-3 p-0 max-[900px]:grid-cols-1">
          {review.batches.map((batch) => (
            <li key={batch.id} className="flex min-w-0">
              <BatchCard batch={batch} older={older} />
            </li>
          ))}
          {(review.pendingBatches ?? 0) > 0 && (
            <li className="min-w-0">
              <PendingBatches review={review} />
            </li>
          )}
        </ul>
      )}
    </section>
  )
}

export interface HomeScreenProps {
  data: HomeData
  /** Shows the list's other filter; the host moves to it (the page's address). */
  onFilterChange?: (filter: ReviewsFilter) => void
  /** What "Start a review" would review now, once the branch moved on. */
  start?: ReviewStart
  onStartReview?: StartReviewHandler
  /** The day groups' "now" and time zone (stories pin them; the page reads the clock). */
  now?: Date
  timeZone?: string
}

function Home({
  data,
  onFilterChange,
  start,
  onStartReview,
  now = new Date(),
  timeZone,
}: HomeScreenProps) {
  const groups = dayGroups(data.reviews, now, timeZone)
  const first = (data.page - 1) * data.pageSize + 1
  const last = first + data.reviews.length - 1
  return (
    <div className="min-h-svh bg-paper font-sans text-sm text-ink">
      <AppHeader repo={data.repo} current="reviews" />
      <main className="mx-auto box-border flex max-w-[1180px] content-fade flex-col gap-10 px-6 pt-14 pb-24 max-[600px]:gap-8 max-[600px]:px-4 max-[600px]:pt-10">
        <section
          {...regionTransition("reviews-hero", 1)}
          className="flex flex-col gap-5"
        >
          <div className="flex flex-col gap-2">
            <h1 className="m-0 text-[40px] leading-[46px] font-semibold tracking-[-0.03em] max-[600px]:text-[30px] max-[600px]:leading-9">
              Reviews
            </h1>
            <p className="m-0 max-w-[620px] text-[15px] leading-6 text-pretty text-ink-2">
              Every review&rsquo;s batches, newest first: what each batch
              changes, what waits on you, and where its review stands.
            </p>
          </div>
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
          <div className="sticky top-0 z-20 -my-3 flex flex-wrap items-center justify-between gap-3 bg-paper py-3">
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
          {/* Keyed by page and filter: each page fades in where it stands. */}
          <div
            key={`${data.filter}:${data.page}`}
            className="flex content-fade flex-col gap-10"
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
                className="flex flex-col gap-4"
              >
                <h3 className="m-0 font-mono text-[11px] font-normal tracking-[0.07em] text-ink-muted uppercase">
                  {group.label}
                </h3>
                <div className="flex flex-col gap-8">
                  {group.reviews.map(({ review, time }) => (
                    <ReviewGroup key={review.id} review={review} time={time} />
                  ))}
                </div>
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
 * The home page — every review of the repository, newest run first, ten to
 * a page, each with its batches: a batch's digest, units by lane, what
 * waits on the reader and the ways into its overview and desk. Nothing is
 * opened for the reader; they pick a batch.
 */
export function HomeScreen(props: HomeScreenProps) {
  return (
    <Provider>
      <MotionConfig reducedMotion="user">
        <Home {...props} />
      </MotionConfig>
    </Provider>
  )
}

function startKey(start: ReviewStart | undefined): string {
  if (start === undefined) return "none"
  if (start.status === "running") return "running"
  if (start.status === "refused") return `refused:${start.message}`
  return `ready:${start.preview.headOid}:${start.preview.mergeBase}:${start.failure ?? ""}`
}

/**
 * `/`: the home page. With no review yet, "Start a review" as the empty
 * overview offers it (ST1–ST4), and the review it started while it runs.
 */
export function HomePage({
  load,
  start,
  onStartReview,
  focusTitle,
  ...screen
}: { load: HomeLoad; focusTitle?: boolean } & Omit<HomeScreenProps, "data">) {
  if (load.status === "empty")
    return (
      // Keyed by what it shows, so a new start view gets a fresh button state.
      <NoBatchEmpty
        key={startKey(start)}
        onStartReview={onStartReview}
        start={start}
        focusTitle={focusTitle}
      />
    )
  return (
    <HomeScreen
      data={load.data}
      start={start}
      onStartReview={onStartReview}
      {...screen}
    />
  )
}
