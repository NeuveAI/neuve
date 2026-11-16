/* ─────────────────────────────────────────────────────────
 * ANIMATION STORYBOARD — Review row
 *
 *    0ms   row hovered (real pointer hover): tone shift (surfaceTone 120ms);
 *          the arrow nudges right (nudge)
 *    0ms   "3 batches" ("2 of 5 batches" while it runs) pressed: the batches list enters, opacity 0 → 1,
 *          y -4 → 0, scale .98 → 1 (card 220ms, emphasized decelerate,
 *          origin top left); it leaves on cardExit 160ms, accelerate
 *  rest    a running review's mark turns (pendingSpin), static under
 *          reduced motion
 *
 * Reduced motion: opacity only (reduced 150ms); no tone transition.
 * ───────────────────────────────────────────────────────── */

import { atom, useAtomValue, useSetAtom } from "jotai"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"
import {
  ArrowRightIcon,
  ChevronDownIcon,
  CircleAlertIcon,
  ClockIcon,
  LoaderCircleIcon,
  MessageCircleIcon,
} from "lucide-react"
import { DropdownMenu } from "radix-ui"

import {
  EASE,
  OFFSET,
  REDUCED_TRANSITION,
  SCALE,
  TIMING,
  ms,
} from "@workspace/ui/lib/motion"
import { cn } from "@workspace/ui/lib/utils"
import { LANE_NAME } from "@workspace/ui/neuve/shared/lane-facts"
import { LaneGlyph } from "@workspace/ui/neuve/shared/lane-glyph"
import { NeuveLink } from "@workspace/ui/neuve/shared/nav-link"
import { VerdictIcon } from "@workspace/ui/neuve/shared/review-mark"
import type { ReviewGateUnit, ReviewSummary } from "@workspace/ui/neuve/types"

const STROKE = 1.75

const MENU = {
  offsetY: -OFFSET.card,
  initialScale: SCALE.enter,
  enter: { duration: ms(TIMING.card), ease: EASE.emphasizedDecelerate },
  exit: { duration: ms(TIMING.cardExit), ease: EASE.emphasizedAccelerate },
} as const

const plural = (count: number, one: string, many: string) =>
  `${count} ${count === 1 ? one : many}`

/** Batches of the review still being reviewed, not published yet. */
const pendingBatches = (review: ReviewSummary) => review.pendingBatches ?? 0

/** The review whose batches list is open; one at a time. */
export const openBatchesAtom = atom<string | null>(null)

export function RunState({ state }: { state: ReviewSummary["state"] }) {
  if (state === "running")
    return (
      <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-ink-2">
        <LoaderCircleIcon
          aria-hidden="true"
          strokeWidth={STROKE}
          className="size-3 motion-safe:animate-pending-spin"
        />
        Running
      </span>
    )
  if (state === "timed-out" || state === "failed") {
    const Icon = state === "failed" ? CircleAlertIcon : ClockIcon
    return (
      <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-warn">
        <Icon aria-hidden="true" strokeWidth={STROKE} className="size-[13px]" />
        {state === "failed" ? "Failed" : "Timed out"}
      </span>
    )
  }
  return <span className="whitespace-nowrap">Completed</span>
}

export function LaneCountsInline({ lanes }: { lanes: ReviewSummary["lanes"] }) {
  if (lanes.length === 0) return null
  return (
    <>
      <span className="sr-only">
        {lanes
          .map((lane) => `${lane.count} ${LANE_NAME[lane.lane]}`)
          .join(", ")}
      </span>
      <ul
        aria-hidden="true"
        // Above the row's link, so each lane's name shows on hover.
        className="relative z-10 m-0 flex list-none flex-nowrap gap-x-3 p-0 text-[12.5px] text-ink-2"
      >
        {lanes.map((lane) => (
          <li
            key={lane.lane}
            title={LANE_NAME[lane.lane]}
            className="inline-flex items-center gap-1.5"
          >
            <LaneGlyph lane={lane.lane} className="size-[9px]" />
            <span className="font-mono tabular-nums">{lane.count}</span>
          </li>
        ))}
      </ul>
    </>
  )
}

/**
 * Squares the row shows; a review with more shows two fewer and "+N", so
 * the squares, the count and "N to decide" stay inside their column.
 */
const SQUARES = 8

/**
 * A square per human-required or human-suggested unit the review asks about
 * (10.127): waiting ones carry their lane's glyph on its tint, decided ones
 * the standing verdict, the agent's included on human-suggested work.
 * One row at most, so a review of a hundred units keeps the row's height.
 */
function GateSquares({ gate }: { gate: Array<ReviewGateUnit> }) {
  if (gate.length === 0) return null
  const waiting = gate.filter((unit) => unit.mark === "waiting").length
  const decided = gate.length - waiting
  const shown = gate.length > SQUARES ? gate.slice(0, SQUARES - 2) : gate
  const rest = gate.length - shown.length
  return (
    <>
      <ul
        aria-label={`Human review: ${decided} of ${gate.length} decided`}
        className="m-0 flex list-none gap-[3px] p-0"
      >
        {shown.map(({ lane, mark }, index) => (
          <li
            key={index}
            className={cn(
              "flex size-4 items-center justify-center rounded-[4px]",
              mark !== "waiting"
                ? "bg-paper shadow-[0_0_0_1px_var(--nv-line)]"
                : lane === "human-required"
                  ? "bg-req-tint shadow-[0_0_0_1px_var(--nv-req-tint-2)]"
                  : "bg-sug-tint shadow-[0_0_0_1px_var(--nv-sug-tint-2)]"
            )}
          >
            {mark === "waiting" ? (
              <LaneGlyph
                lane={lane}
                outline={lane === "human-required"}
                className="size-2"
              />
            ) : (
              <VerdictIcon
                verdict={mark === "approved" ? "approved" : "changes_requested"}
                className="size-[9px]"
              />
            )}
          </li>
        ))}
        {rest > 0 && (
          <li
            aria-hidden="true"
            className="flex h-4 items-center pl-0.5 font-mono text-[11px] text-ink-muted tabular-nums"
          >
            +{rest}
          </li>
        )}
      </ul>
      <span
        className={cn(
          "text-[13px] whitespace-nowrap",
          waiting > 0 ? "font-medium text-req-fg" : "text-ink-muted"
        )}
      >
        {waiting > 0 ? `${waiting} to decide` : "Decided"}
      </span>
    </>
  )
}

function BatchesMenu({ review }: { review: ReviewSummary }) {
  const open = useAtomValue(openBatchesAtom) === review.id
  const setOpen = useSetAtom(openBatchesAtom)
  const reduce = useReducedMotion()
  return (
    <DropdownMenu.Root
      open={open}
      onOpenChange={(next) => setOpen(next ? review.id : null)}
      modal={false}
    >
      <DropdownMenu.Trigger asChild>
        {/* Above the row's link, so it opens the list rather than the review. */}
        <button
          type="button"
          className={cn(
            "relative z-10 -mx-1.5 inline-flex h-6 cursor-pointer items-center gap-1 rounded-md border-0 bg-transparent px-1.5 text-[12.5px] text-ink-2 transition-colors duration-surface-tone ease-standard hover:bg-raised-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus focus-visible:outline-solid motion-reduce:transition-none",
            open && "bg-raised-2 text-ink"
          )}
        >
          {pendingBatches(review) > 0
            ? `${review.batches.length} of ${review.batches.length + pendingBatches(review)} batches`
            : plural(review.batches.length, "batch", "batches")}
          <ChevronDownIcon
            aria-hidden="true"
            strokeWidth={STROKE}
            className="size-[13px] text-ink-muted"
          />
        </button>
      </DropdownMenu.Trigger>
      <AnimatePresence>
        {open && (
          <DropdownMenu.Portal forceMount>
            <DropdownMenu.Content
              forceMount
              asChild
              align="start"
              sideOffset={6}
              collisionPadding={16}
            >
              <motion.div
                initial={
                  reduce
                    ? { opacity: 0 }
                    : { opacity: 0, y: MENU.offsetY, scale: MENU.initialScale }
                }
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={
                  reduce
                    ? { opacity: 0, transition: REDUCED_TRANSITION }
                    : { opacity: 0, y: MENU.offsetY, transition: MENU.exit }
                }
                transition={reduce ? REDUCED_TRANSITION : MENU.enter}
                style={{ transformOrigin: "top left" }}
                // A long list scrolls inside itself, never past the screen.
                className="z-30 box-border flex max-h-[min(360px,var(--radix-dropdown-menu-content-available-height))] w-[min(380px,calc(100vw-32px))] flex-col gap-0.5 overflow-y-auto overscroll-contain rounded-xl bg-surface p-1 font-sans text-sm text-ink shadow-card outline-none"
              >
                {review.batches.map((batch) => (
                  <DropdownMenu.Item key={batch.id} asChild>
                    <NeuveLink
                      destination={{ to: "overview", batchId: batch.id }}
                      className="flex flex-col gap-0.5 rounded-lg px-2.5 py-2 text-ink no-underline outline-hidden transition-colors duration-surface-tone ease-standard hover:text-ink data-highlighted:bg-raised motion-reduce:transition-none"
                    >
                      <span className="text-[13px] leading-5 font-medium text-pretty">
                        {batch.title}
                      </span>
                      <span className="font-mono text-[11px] text-ink-muted">
                        {batch.needYou > 0 && (
                          <span className="text-req-fg">
                            {batch.needYou} to decide ·{" "}
                          </span>
                        )}
                        {plural(batch.unitCount, "unit", "units")}
                      </span>
                    </NeuveLink>
                  </DropdownMenu.Item>
                ))}
              </motion.div>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        )}
      </AnimatePresence>
    </DropdownMenu.Root>
  )
}

/**
 * One review: its title (opening its first batch), range, time and state,
 * its units by lane, what waits on a person, whether anyone gave feedback,
 * and its batches when it has several, or while more are being reviewed
 * ("2 of 5 batches": published of all). A review without a batch yet (running
 * or failed before publishing) opens nothing. An older review, whose units a
 * newer review holds, says "Replaced by a newer review" in place of its
 * squares.
 */
export function ReviewRow({
  review,
  time,
}: {
  review: ReviewSummary
  /** The run's time, as the page's day groups format it. */
  time: string
}) {
  const first = review.batches[0]
  return (
    <div
      className={cn(
        "relative box-border grid min-h-16 grid-cols-[minmax(0,1fr)_132px_248px_16px_15px] items-center gap-x-6 gap-y-2 px-5 py-3 transition-colors duration-surface-tone ease-standard motion-reduce:transition-none",
        "max-[760px]:grid-cols-[minmax(0,1fr)_16px] max-[760px]:gap-x-4 max-[760px]:gap-y-2.5 max-[760px]:px-4 max-[760px]:py-3.5 max-[760px]:[grid-template-areas:'main_go'_'foot_foot']",
        first &&
          "group/row hover:bg-raised has-[.row-link:focus-visible]:outline-2 has-[.row-link:focus-visible]:-outline-offset-2 has-[.row-link:focus-visible]:outline-focus has-[.row-link:focus-visible]:outline-solid"
      )}
    >
      <div className="flex min-w-0 flex-col gap-1 max-[760px]:[grid-area:main]">
        <span
          title={review.title}
          className="truncate text-[15.5px] leading-[22px] font-semibold tracking-[-0.01em] max-[760px]:line-clamp-2 max-[760px]:whitespace-normal"
        >
          {first ? (
            <NeuveLink
              destination={{ to: "overview", batchId: first.id }}
              className="row-link text-ink no-underline outline-none after:absolute after:inset-0 hover:text-ink"
            >
              {review.title}
            </NeuveLink>
          ) : (
            review.title
          )}
        </span>
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] text-ink-muted">
          <span translate="no" className="font-mono">
            {review.range}
          </span>
          <span aria-hidden="true" className="text-faint">
            ·
          </span>
          <span className="font-mono tabular-nums">{time}</span>
          <span aria-hidden="true" className="text-faint">
            ·
          </span>
          <RunState state={review.state} />
          {/* A review still publishing lists its batches from the first. */}
          {(review.batches.length > 1 ||
            (review.batches.length > 0 && pendingBatches(review) > 0)) && (
            <>
              <span aria-hidden="true" className="text-faint">
                ·
              </span>
              <BatchesMenu review={review} />
            </>
          )}
        </span>
      </div>
      {/* Its own grid cells at desktop; on a phone one line under the title
          that wraps the decisions onto a second only when they don't fit. */}
      <div className="contents max-[760px]:flex max-[760px]:flex-wrap max-[760px]:items-center max-[760px]:gap-x-4 max-[760px]:gap-y-2.5 max-[760px]:[grid-area:foot]">
        <div className="flex min-w-0 max-[760px]:empty:hidden">
          <LaneCountsInline lanes={review.lanes} />
        </div>
        <div className="flex min-w-0 items-center gap-2.5 max-[760px]:empty:hidden">
          {/* A newer review holds its units: it asks for nothing here. */}
          {review.newer ? (
            <span className="text-[13px] whitespace-nowrap text-ink-muted">
              Replaced by a newer review
            </span>
          ) : (
            <GateSquares gate={review.gate} />
          )}
        </div>
        <span className="inline-flex text-ink-muted max-[760px]:ml-auto max-[760px]:empty:hidden">
          {review.feedback && (
            <span title="Feedback given" className="relative z-10 inline-flex">
              <MessageCircleIcon
                aria-hidden="true"
                strokeWidth={STROKE}
                className="size-3.5"
              />
              <span className="sr-only">Feedback given</span>
            </span>
          )}
        </span>
      </div>
      <span className="inline-flex max-[760px]:self-start max-[760px]:pt-1 max-[760px]:[grid-area:go]">
        {first && (
          <ArrowRightIcon
            aria-hidden="true"
            strokeWidth={STROKE}
            className="size-[15px] text-faint transition-[transform,color] duration-nudge ease-ios-out group-hover/row:translate-x-(--nv-offset-nudge) group-hover/row:text-ink motion-reduce:transition-none"
          />
        )}
      </span>
    </div>
  )
}
