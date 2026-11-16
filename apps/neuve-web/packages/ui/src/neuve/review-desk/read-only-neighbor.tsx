/* ─────────────────────────────────────────────────────────
 * ANIMATION STORYBOARD — Read-only neighbor collapse
 *
 *    0ms   toggle pressed; chevron turns 0 → 180° (chevron 200ms, standard)
 *    0ms   rows rise: opacity 0 → 1, y 8 → 0, scale .98 → 1
 *          (dockRise 240ms, emphasized decelerate, origin bottom)
 *    0ms   its muted context pins appear with the rows (overlay layer)
 *  hide    rows fade out (dockExit 120ms, accelerate)
 *
 * Reduced motion: chevron snaps, rows fade 150ms.
 * ───────────────────────────────────────────────────────── */

import { useAtomValue, useSetAtom } from "jotai"
import { motion, useReducedMotion } from "motion/react"
import { ChevronDownIcon, LockIcon, MessageCircleIcon } from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import { EASE, TIMING, ms } from "@workspace/ui/lib/motion"
import { cn } from "@workspace/ui/lib/utils"
import { NeuveLink } from "@workspace/ui/neuve/shared/nav-link"
import {
  neighborOpenAtom,
  toggleNeighborAtom,
} from "@workspace/ui/neuve/review-desk/atoms"
import { DiffFileCard } from "@workspace/ui/neuve/review-desk/diff-file"
import type { CommentContext } from "@workspace/ui/neuve/review-desk/diff-file"
import type { ReviewCommentRecord } from "@workspace/ui/neuve/review-comments/record"
import type {
  ContextualMarker,
  MarkerAnchor,
  ReadOnlyNeighbor as Neighbor,
} from "@workspace/ui/neuve/types"

/**
 * A read-only neighbor: a hunk from another lane shown for context. Muted
 * grayscale (the `.nv-diff-readonly` variant of the forked renderer),
 * collapsed by default. Expanded, it shows its own surrounding context as
 * muted pins. You can comment on it — the comment belongs to its own unit —
 * and its decision stays in its own lane; this unit's disposition never
 * applies to it.
 */
export function ReadOnlyNeighbor({
  neighbor,
  markers = {},
  commentAnchors,
  comments,
  commentContext,
}: {
  neighbor: Neighbor
  /** Review-comment markers on the neighbor (its own unit's records). */
  markers?: Record<string, ContextualMarker>
  commentAnchors?: ReadonlyArray<MarkerAnchor>
  comments?: Record<string, ReviewCommentRecord>
  /** Reviewer and revision; the unit is the neighbor's own. */
  commentContext: CommentContext
}) {
  const open = useAtomValue(neighborOpenAtom)
  const toggle = useSetAtom(toggleNeighborAtom)
  const reduce = useReducedMotion()
  const regionId = `neighbor-${neighbor.path.replace(/[^a-z0-9]+/gi, "-")}`

  // One line where the card has room. In a narrow card (a phone's column)
  // the note and the context count take a second line, under the path, so
  // the toggle stays inside the card and the path keeps its room.
  const header = (
    <div className="@container">
      <div className="box-border flex h-11 items-center gap-2.5 pr-2 pl-3.5 @max-[34rem]:grid @max-[34rem]:h-auto @max-[34rem]:grid-cols-[auto_minmax(0,1fr)_auto] @max-[34rem]:gap-y-1 @max-[34rem]:py-2">
        <LockIcon
          aria-hidden="true"
          className="size-3 shrink-0 text-ink-muted"
          strokeWidth={1.6}
        />
        <span className="min-w-0 truncate font-mono text-xs text-ink-muted">
          {neighbor.path}
        </span>
        <span className="text-xs whitespace-nowrap text-ink-muted @max-[34rem]:col-span-2 @max-[34rem]:row-start-2 @max-[34rem]:min-w-0 @max-[34rem]:truncate">
          {neighbor.note}
        </span>
        <span className="flex-auto @max-[34rem]:hidden" />
        {neighbor.contextNotes.length > 0 && (
          <span className="rounded-sm px-1.5 py-px font-mono text-[11px] whitespace-nowrap text-ink-muted shadow-[inset_0_0_0_1px_var(--nv-line)] @max-[34rem]:col-start-3 @max-[34rem]:row-start-2 @max-[34rem]:justify-self-end">
            {neighbor.contextNotes.length} context
          </span>
        )}
        <Button
          type="button"
          variant="quiet"
          size="compact"
          aria-expanded={open}
          aria-controls={regionId}
          onClick={toggle}
          className="@max-[34rem]:col-start-3 @max-[34rem]:row-start-1"
        >
          {/* Both words share one cell, so the chevron never slides. */}
          <span className="grid justify-items-center">
            <span
              className={cn("col-start-1 row-start-1", !open && "invisible")}
            >
              Hide
            </span>
            <span
              className={cn("col-start-1 row-start-1", open && "invisible")}
            >
              Show
            </span>
          </span>
          <motion.span
            aria-hidden="true"
            className="inline-flex"
            animate={{ rotate: open ? 180 : 0 }}
            transition={
              reduce
                ? { duration: 0 }
                : { duration: ms(TIMING.chevron), ease: EASE.standard }
            }
          >
            <ChevronDownIcon className="size-2.5" strokeWidth={2} />
          </motion.span>
        </Button>
      </div>
    </div>
  )

  return (
    <DiffFileCard
      file={neighbor.file}
      variant="read-only"
      markers={markers}
      commentAnchors={commentAnchors}
      comments={comments}
      commentContext={{
        ...commentContext,
        unitId: neighbor.unitId,
        agentId: neighbor.agentId,
      }}
      contextNotes={open ? neighbor.contextNotes : []}
      header={header}
      collapsed={!open}
      surfaceId={regionId}
      footer={
        <div className="flex items-center gap-2 px-3.5 py-2.5 text-xs text-ink-muted">
          <MessageCircleIcon aria-hidden="true" className="size-[13px]" />
          You can comment here. Its decision stays with {neighbor.laneLabel}.
          <NeuveLink
            destination={{ to: "unit", unitId: neighbor.unitId }}
            aria-label={`Open full unit for ${neighbor.path}`}
            className="text-ink-muted underline underline-offset-2 hover:text-ink"
          >
            Open full unit
          </NeuveLink>
        </div>
      }
    />
  )
}
