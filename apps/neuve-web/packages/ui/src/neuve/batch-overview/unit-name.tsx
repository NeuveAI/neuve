/* ─────────────────────────────────────────────────────────
 * ANIMATION STORYBOARD — Moved-up mark (overview rows)
 *
 *  rest    a muted up arrow after the unit's title
 *    0ms   the arrow is hovered (real pointer hover), or its row's link has
 *          keyboard focus: the tooltip fades in (hint, iOS out)
 *
 * Reduced motion: the tooltip appears without the fade.
 * ───────────────────────────────────────────────────────── */

import { atom, useAtomValue, useSetAtom } from "jotai"
import type * as React from "react"

import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip"
import {
  MovedUpMark,
  UntitledFolder,
  UntitledLines,
  movedUpLabel,
  untitledName,
} from "@workspace/ui/neuve/shared/lane-facts"
import type { ReviewLane, UntitledFile } from "@workspace/ui/neuve/types"

/** The moved-up mark whose tooltip shows, by its id; one at a time. */
const openMovedUpAtom = atom<string | null>(null)

/**
 * Focus handlers for a row's link: keyboard focus opens the row's moved-up
 * tooltip, as real pointer hover on the mark does.
 */
export function useMovedUpFocus(markId: string | undefined) {
  const setOpen = useSetAtom(openMovedUpAtom)
  if (!markId) return {}
  return {
    onFocus: (event: React.FocusEvent<HTMLElement>) => {
      if (event.currentTarget.matches(":focus-visible")) setOpen(markId)
    },
    onBlur: () => setOpen(null),
  }
}

/**
 * The shared moved-up mark on an overview row, after the title: its words
 * in a tooltip on real pointer hover and while the row's link has keyboard
 * focus. The row's link is described by it (`aria-describedby`).
 */
export function MovedUpTip({ id, from }: { id: string; from: ReviewLane }) {
  const open = useAtomValue(openMovedUpAtom) === id
  const setOpen = useSetAtom(openMovedUpAtom)
  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip
        open={open}
        // Escape (and Radix's other dismissals) close it (WCAG 1.4.13).
        onOpenChange={(next) => {
          if (!next) setOpen(null)
        }}
      >
        <TooltipTrigger asChild>
          <span
            onPointerEnter={(event) => {
              if (event.pointerType === "mouse") setOpen(id)
            }}
            onPointerLeave={() => setOpen(null)}
            // Above the row's link, so real pointer hover reaches it.
            className="relative z-10 inline-flex shrink-0"
          >
            <MovedUpMark id={id} from={from} />
          </span>
        </TooltipTrigger>
        <TooltipContent side="top">{movedUpLabel(from)}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

/**
 * A unit with no written title on an overview row: its file's name, the
 * lines it owns there and the folder, on one line (the folder on its own
 * line on a phone). The title stays the accessible name.
 */
export function UntitledOnOneLine({
  title,
  files,
}: {
  title: string
  files: ReadonlyArray<UntitledFile>
}) {
  const name = untitledName({ files })
  if (!name) return title
  return (
    <>
      <span className="sr-only">{title}</span>
      {/* A long list of lines wraps inside the title's column, never under
      the row's review mark, so every line stays readable. */}
      <span
        aria-hidden="true"
        className="flex min-w-0 flex-wrap items-baseline gap-x-2"
      >
        <span className="shrink-0">{name.name}</span>
        <UntitledLines name={name} className="min-w-0 text-[11.5px]" />
        <UntitledFolder
          name={name}
          className="text-[11px] max-[600px]:basis-full"
        />
      </span>
    </>
  )
}
