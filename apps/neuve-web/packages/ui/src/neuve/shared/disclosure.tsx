/* ─────────────────────────────────────────────────────────
 * ANIMATION STORYBOARD — Disclosure (Polish.dc.html "One disclosure style")
 *
 *    0ms   row hover: tone shift (surfaceTone 120ms, CSS, real hover only)
 *    0ms   open: chevron turns 0 → 90° (chevron 200ms, standard, CSS);
 *          the content rises y -4 → 0, opacity 0 → 1
 *          (chevron 200ms, emphasized decelerate)
 *  close   the content hides at once (native <details>)
 *
 * Reduced motion: the chevron snaps; the content fades in (reduced 150ms).
 * ───────────────────────────────────────────────────────── */

import type * as React from "react"
import { animate, useReducedMotion } from "motion/react"
import { ChevronRightIcon } from "lucide-react"

import {
  EASE,
  REDUCED_TRANSITION,
  TIMING,
  ms,
  OFFSET,
} from "@workspace/ui/lib/motion"
import { cn } from "@workspace/ui/lib/utils"

const REVEAL = {
  offsetY: -OFFSET.card,
  transition: { duration: ms(TIMING.chevron), ease: EASE.emphasizedDecelerate },
} as const

function Chevron() {
  return (
    <ChevronRightIcon
      aria-hidden="true"
      strokeWidth={1.75}
      className="size-3.5 shrink-0 text-faint transition-transform duration-chevron ease-standard group-open/disclosure:rotate-90 motion-reduce:transition-none"
    />
  )
}

/**
 * The one disclosure row: a 40px chevron row with a label and an optional
 * count chip. Built on native <details>, so find-in-page reveals the content
 * and the open state needs no React state; the reveal is a one-shot motion
 * animation started from the toggle event.
 */
export function Disclosure({
  label,
  count,
  leading,
  trailing,
  chevron = "start",
  defaultOpen = false,
  children,
  className,
  summaryClassName,
  contentClassName,
}: {
  label: React.ReactNode
  count?: number | string
  /** Before the label, e.g. a lane glyph (list rows). */
  leading?: React.ReactNode
  /** After the label and count, e.g. a status chip (list rows). */
  trailing?: React.ReactNode
  /** List rows put the chevron at the end (Polish.dc.html lineage rows). */
  chevron?: "start" | "end"
  defaultOpen?: boolean
  children: React.ReactNode
  className?: string
  summaryClassName?: string
  /** Padding of the revealed content (defaults to the label's inset). */
  contentClassName?: string
}) {
  const reduce = useReducedMotion()
  return (
    <details
      open={defaultOpen}
      onToggle={(event) => {
        const details = event.currentTarget
        const content = details.lastElementChild
        if (!details.open || !(content instanceof HTMLElement)) return
        void animate(
          content,
          reduce
            ? { opacity: [0, 1] }
            : { opacity: [0, 1], y: [REVEAL.offsetY, 0] },
          reduce ? REDUCED_TRANSITION : REVEAL.transition
        )
      }}
      className={cn("group/disclosure", className)}
    >
      <summary
        className={cn(
          "flex h-10 cursor-pointer list-none items-center gap-2.5 rounded-lg px-2.5 text-[13px] text-ink-2 transition-colors duration-surface-tone ease-standard select-none hover:bg-raised focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus motion-reduce:transition-none [&::-webkit-details-marker]:hidden",
          summaryClassName
        )}
      >
        {chevron === "start" && <Chevron />}
        {leading}
        <span
          className={cn("min-w-0 truncate", chevron === "end" && "flex-auto")}
        >
          {label}
        </span>
        {count !== undefined && (
          <span className="shrink-0 rounded-[4px] bg-raised px-1.5 py-px font-mono text-[11px] text-ink-muted">
            {count}
          </span>
        )}
        {trailing}
        {chevron === "end" && <Chevron />}
      </summary>
      <div className={cn("pt-1 pr-3 pb-2 pl-[34px]", contentClassName)}>
        {children}
      </div>
    </details>
  )
}
