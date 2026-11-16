/* ─────────────────────────────────────────────────────────
 * ANIMATION STORYBOARD — Batch card (home page)
 *
 *    0ms   card hovered (real pointer hover): tone shift (surfaceTone
 *          120ms)
 *    0ms   "Open desk" hovered: its tone shifts; its arrow nudges (nudge)
 *
 * Nothing moves on first paint. Reduced motion: no tone transition.
 * ───────────────────────────────────────────────────────── */

/*
 * Built from the Neuve design system (Figma "Design System", Components):
 * the surface and title of a Reviews row, "Reviews / Lane count" for the
 * lanes, "N to decide" as "Reviews / Gate square" says it, the batch
 * overview's digest sections ("What changed", "Removed, disabled or
 * narrowed", "What to check") and the quiet button of "Reviews / Batches
 * trigger" for Open desk. Text styles: Sans/15.5/Semibold (title),
 * Sans/14/Regular · lh 21 (digest), Sans/12.5/Regular · lh 18 (sections),
 * Sans/13 (what waits).
 */

import { ArrowRightIcon } from "lucide-react"

import { cn } from "@workspace/ui/lib/utils"
import type { HomeBatch } from "@workspace/ui/neuve/home/home-data"
import { LaneCountsInline } from "@workspace/ui/neuve/reviews/review-row"
import { emphasisParts } from "@workspace/ui/neuve/shared/digest-emphasis"
import { NeuveLink } from "@workspace/ui/neuve/shared/nav-link"

const STROKE = 1.75

const plural = (count: number, one: string, many: string) =>
  `${count} ${count === 1 ? one : many}`

/** The digest's words, with `**Label:**` bold (10.140). */
function Emphasized({ text }: { text: string }) {
  return emphasisParts(text).map((part, index) =>
    part.strong ? (
      <strong key={index} className="font-semibold text-ink">
        {part.text}
      </strong>
    ) : (
      part.text
    )
  )
}

/**
 * What the batch asks of the reader (14.33), in the Reviews row's words:
 * "2 to decide" while units wait on them, "Decided" once a decision stands
 * on each, nothing when it asks for no person's decision.
 */
function WaitingMark({ batch }: { batch: HomeBatch }) {
  if (batch.needYou === 0 && batch.asked === 0) return null
  return (
    <span
      className={cn(
        "shrink-0 pt-px text-[13px] whitespace-nowrap",
        batch.needYou > 0 ? "font-medium text-req-fg" : "text-ink-muted"
      )}
    >
      {batch.needYou > 0 ? `${batch.needYou} to decide` : "Decided"}
    </span>
  )
}

/**
 * One batch of a review: its title (opening its batch overview), what waits
 * on the reader, its batch digest, what it removes, disables or narrows
 * (13.19), what to check, its units by lane, and the way into its review
 * desk. An older review's batch asks for nothing and reads quieter.
 */
export function BatchCard({
  batch,
  older = false,
}: {
  batch: HomeBatch
  /** A newer review holds its units (14.33). */
  older?: boolean
}) {
  const removes = batch.removes ?? []
  return (
    <article
      aria-label={batch.title}
      className={cn(
        "group/card relative box-border flex min-w-0 flex-col gap-3 rounded-[14px] bg-surface p-5 shadow-[0_0_0_1px_var(--nv-line)] transition-colors duration-surface-tone ease-standard hover:bg-raised motion-reduce:transition-none max-[600px]:p-4",
        "has-[.card-link:focus-visible]:outline-2 has-[.card-link:focus-visible]:outline-offset-2 has-[.card-link:focus-visible]:outline-focus has-[.card-link:focus-visible]:outline-solid"
      )}
    >
      <header className="flex items-start justify-between gap-3">
        <h4
          className={cn(
            "m-0 min-w-0 text-[15.5px] leading-[22px] font-semibold tracking-[-0.01em] text-pretty",
            older && "text-ink-2"
          )}
        >
          <NeuveLink
            destination={{ to: "overview", batchId: batch.id }}
            className="card-link text-inherit no-underline outline-none after:absolute after:inset-0 after:rounded-[14px] hover:text-inherit"
          >
            {batch.title}
          </NeuveLink>
        </h4>
        <WaitingMark batch={batch} />
      </header>
      {batch.digest ? (
        <p
          className={cn(
            "m-0 line-clamp-3 text-[14px] leading-[21px] text-pretty text-ink-2",
            older && "text-ink-muted"
          )}
        >
          <Emphasized text={batch.digest} />
        </p>
      ) : (
        <p className="m-0 text-[14px] leading-[21px] text-ink-muted">
          No batch digest for this batch.
        </p>
      )}
      {(removes.length > 0 || batch.toCheck) && (
        <div className="flex flex-col gap-1.5 text-[12.5px] leading-[18px] text-ink-2">
          {removes.length > 0 && (
            <p className="m-0 line-clamp-2 min-w-0">
              <span className="font-medium text-ink">
                Removed, disabled or narrowed:
              </span>{" "}
              {removes[0]}
              {removes.length > 1 && (
                <span className="text-ink-muted">
                  {" "}
                  and {removes.length - 1} more
                </span>
              )}
            </p>
          )}
          {batch.toCheck && (
            <p className="m-0 line-clamp-1 min-w-0">
              <span className="font-medium text-ink">What to check:</span>{" "}
              {batch.toCheck}
            </p>
          )}
        </div>
      )}
      <footer className="mt-auto flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-line-2 pt-3">
        {/* The lanes' counts add up to its units; without lanes, the count alone. */}
        {batch.lanes.length > 0 ? (
          <div className="flex min-w-0">
            <LaneCountsInline lanes={batch.lanes} />
          </div>
        ) : (
          <span className="font-mono text-[12.5px] text-ink-muted tabular-nums">
            {plural(batch.unitCount, "unit", "units")}
          </span>
        )}
        {batch.deskUnitId && (
          // Above the card's link, so it opens the desk rather than the overview.
          <NeuveLink
            destination={{ to: "unit", unitId: batch.deskUnitId }}
            className="group/desk relative z-10 -mr-1.5 ml-auto inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-[12.5px] text-ink-2 no-underline transition-colors duration-surface-tone ease-standard hover:bg-raised-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus focus-visible:outline-solid motion-reduce:transition-none"
          >
            Open desk
            <ArrowRightIcon
              aria-hidden="true"
              strokeWidth={STROKE}
              className="size-[13px] text-ink-muted transition-transform duration-nudge ease-ios-out group-hover/desk:translate-x-(--nv-offset-nudge) motion-reduce:transition-none"
            />
          </NeuveLink>
        )}
      </footer>
    </article>
  )
}
