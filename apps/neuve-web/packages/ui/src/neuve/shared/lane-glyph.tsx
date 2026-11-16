import { cn } from "@workspace/ui/lib/utils"
import type { ReviewLane } from "@workspace/ui/neuve/types"

/**
 * Lane glyphs from the designs: filled diamond (human-required), half-filled
 * diamond (human-suggested), ring (agentic review), rounded square (static
 * automation). Shape carries the lane, so colour is never the only signal.
 */
export function LaneGlyph({
  lane,
  outline = false,
  className,
}: {
  lane: ReviewLane
  /** Human-required only: an outlined diamond (a unit not selected). */
  outline?: boolean
  className?: string
}) {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 10 10"
      aria-hidden="true"
      className={className}
    >
      {lane === "human-required" &&
        (outline ? (
          <path
            d="M5 .8 9.2 5 5 9.2 .8 5z"
            fill="none"
            stroke="var(--nv-req)"
            strokeWidth="1.4"
          />
        ) : (
          <path d="M5 .8 9.2 5 5 9.2 .8 5z" fill="var(--nv-req)" />
        ))}
      {lane === "human-suggested" && (
        <>
          <path
            d="M5 .8 9.2 5 5 9.2 .8 5z"
            fill="none"
            stroke="var(--nv-sug)"
            strokeWidth="1.4"
          />
          <path d="M5 .8V9.2L.8 5z" fill="var(--nv-sug)" />
        </>
      )}
      {lane === "agentic-review" && (
        <circle
          cx="5"
          cy="5"
          r="3.9"
          fill="none"
          stroke="var(--nv-agt)"
          strokeWidth="1.6"
        />
      )}
      {lane === "static-automation" && (
        <rect
          x="1.2"
          y="1.2"
          width="7.6"
          height="7.6"
          rx="1.5"
          fill="none"
          stroke="var(--nv-sta)"
          strokeWidth="1.5"
        />
      )}
    </svg>
  )
}

const LANE_INK: Record<ReviewLane, string> = {
  "human-required": "var(--nv-req)",
  "human-suggested": "var(--nv-sug)",
  "agentic-review": "var(--nv-agt)",
  "static-automation": "var(--nv-sta)",
}

/**
 * The lane glyph's place while its unit loads (Polish.dc.html "Switching
 * units"): a ring track with a lane-coloured arc, turning (workingSpin,
 * animate-working-spin). Under reduced motion it holds still: the arc on
 * its track still reads as loading.
 */
export function LaneSpinner({
  lane,
  className,
}: {
  lane?: ReviewLane
  className?: string
}) {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 10 10"
      aria-hidden="true"
      className={cn("shrink-0 motion-safe:animate-working-spin", className)}
    >
      <circle
        cx="5"
        cy="5"
        r="3.8"
        fill="none"
        stroke="var(--nv-line)"
        strokeWidth="1.6"
      />
      <path
        d="M5 1.2a3.8 3.8 0 0 1 3.8 3.8"
        fill="none"
        stroke={lane ? LANE_INK[lane] : "var(--nv-muted)"}
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  )
}
