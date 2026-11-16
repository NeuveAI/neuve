import { CircleAlertIcon } from "lucide-react"

import { cn } from "@workspace/ui/lib/utils"
import type { UnitCheckpoints } from "@workspace/ui/neuve/types"

const STROKE = 1.75

/**
 * A unit's unmet checkpoints in one count (10.110): "3 unmet", where unmet
 * is Missing, Out of date or Conflicting (11.19). A unit with none unmet
 * shows nothing, never "met", so thin proof is not shown as met either.
 * The checkpoints themselves are on the unit's page, which the row opens.
 */
export function CheckpointCount({
  checkpoints,
  className,
}: {
  checkpoints: UnitCheckpoints | undefined
  className?: string
}) {
  if (!checkpoints || checkpoints.unmet === 0) return null
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 text-[13px] whitespace-nowrap text-sug-fg",
        className
      )}
    >
      <CircleAlertIcon
        aria-hidden="true"
        className="size-[13px] shrink-0"
        strokeWidth={STROKE}
      />
      {checkpoints.unmet} unmet
      <span className="sr-only">
        {checkpoints.unmet === 1 ? " checkpoint" : " checkpoints"}
      </span>
    </span>
  )
}

/**
 * The row's link stretches over the whole row, so a press anywhere opens the
 * unit. The row draws the link's focus ring.
 */
export const ROW_LINK =
  "text-ink no-underline outline-hidden after:absolute after:inset-0 after:content-[''] hover:text-ink"
export const ROW_FOCUS =
  "has-[[data-row-link]:focus-visible]:outline-2 has-[[data-row-link]:focus-visible]:-outline-offset-2 has-[[data-row-link]:focus-visible]:outline-focus has-[[data-row-link]:focus-visible]:outline-solid"
