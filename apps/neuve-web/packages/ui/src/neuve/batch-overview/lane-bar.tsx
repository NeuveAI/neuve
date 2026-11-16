/* ─────────────────────────────────────────────────────────
 * ANIMATION STORYBOARD — Lane bar (Polish.dc.html, round 3)
 *
 *  rest    a thin bar of solid lane colours, every lane at full strength;
 *          the legend below names each lane with its glyph and count
 *    0ms   a legend item (or its bar segment) is hovered (real pointer
 *          hover): the other segments dim to 40% (laneTone 160ms, standard)
 *  leave   every segment returns to full strength (laneTone 160ms)
 *
 * Reduced motion: the dimming stays; it fades in 150ms (opacity only).
 * ───────────────────────────────────────────────────────── */

import { useAtomValue, useSetAtom } from "jotai"
import { motion, useReducedMotion } from "motion/react"

import {
  EASE,
  REDUCED_TRANSITION,
  TIMING,
  ms,
  OPACITY,
} from "@workspace/ui/lib/motion"
import { cn } from "@workspace/ui/lib/utils"
import {
  activeLaneAtom,
  pickLaneAtom,
  resetLaneAtom,
} from "@workspace/ui/neuve/batch-overview/atoms"
import { LaneGlyph } from "@workspace/ui/neuve/shared/lane-glyph"
import { notReadCount } from "@workspace/ui/neuve/shared/lane-facts"
import type { LaneSummary, ReviewLane } from "@workspace/ui/neuve/types"

const LANE_FILL: Record<ReviewLane, string> = {
  "human-required": "bg-req",
  "human-suggested": "bg-sug",
  "agentic-review": "bg-agt",
  "static-automation": "bg-sta",
}

const LANE = {
  dimmedOpacity: OPACITY.laneDim,
  /** A lane with no units keeps a 6px stub, so the bar still names it. */
  stub: 6,
  tone: { duration: ms(TIMING.laneTone), ease: EASE.standard },
} as const

/**
 * Lane split for the whole batch: a thin proportional bar of solid lane
 * colours and a legend with each lane's glyph, name and count. Only the
 * human-required lane says it is waiting on you. Pointing at a lane in the
 * legend or the bar dims the others; the legend's text carries everything,
 * so nothing depends on the pointer.
 */
export function LaneBar({
  lanes,
  waiting,
  notRead = 0,
}: {
  lanes: Array<LaneSummary>
  /** Human-required units still waiting on your decision. */
  waiting: number
  /** Lockfiles and generated files no agent read. */
  notRead?: number
}) {
  const active = useAtomValue(activeLaneAtom)
  const pick = useSetAtom(pickLaneAtom)
  const reset = useSetAtom(resetLaneAtom)
  const reduce = useReducedMotion()
  const summary = lanes.map((lane) => `${lane.name} ${lane.count}`).join(", ")

  return (
    <section
      id="lanes"
      aria-label="Review units by review lane"
      className="flex scroll-mt-6 flex-col gap-2.5"
      onMouseLeave={reset}
    >
      <div
        role="img"
        aria-label={summary}
        className="flex h-2.5 gap-[3px] overflow-hidden rounded-[5px]"
      >
        {lanes.map((lane) => (
          <motion.span
            key={lane.lane}
            onMouseEnter={() => pick(lane.lane)}
            animate={{
              opacity:
                active === null || active === lane.lane
                  ? 1
                  : LANE.dimmedOpacity,
            }}
            transition={reduce ? REDUCED_TRANSITION : LANE.tone}
            style={
              lane.count > 0
                ? { flex: `${lane.count} 1 0` }
                : { flex: `0 0 ${LANE.stub}px` }
            }
            className={cn(
              "rounded-[2px]",
              lane.count > 0 ? LANE_FILL[lane.lane] : "bg-line-strong"
            )}
          />
        ))}
      </div>
      <ul
        aria-label="Review lanes"
        className="m-0 flex list-none flex-wrap gap-x-5 gap-y-2 p-0 text-[12.5px]"
      >
        {lanes.map((lane) => {
          const empty = lane.count === 0
          return (
            <li
              key={lane.lane}
              onMouseEnter={() => pick(lane.lane)}
              className={cn(
                "inline-flex items-center gap-[7px]",
                empty ? "text-ink-muted" : "text-ink-2"
              )}
            >
              <LaneGlyph lane={lane.lane} className="size-[9px]" />
              {lane.name}
              <span className={cn("font-mono", empty ? undefined : "text-ink")}>
                {lane.count}
              </span>
              {lane.lane === "human-required" && waiting > 0 && (
                <span className="font-mono text-[11px] text-req-fg">
                  {waiting} waiting on you
                </span>
              )}
            </li>
          )
        })}
        {notRead > 0 && <NotReadCount count={notRead} />}
      </ul>
    </section>
  )
}

/** "2 files not read": quiet, after the lanes, never a lane of its own. */
function NotReadCount({ count }: { count: number }) {
  return (
    <li
      data-not-read-count=""
      className="inline-flex items-center text-ink-muted"
    >
      {notReadCount(count)}
    </li>
  )
}

/**
 * The lane split as counts only, for when nothing waits on you: each lane's
 * glyph, name and count, without the bar.
 */
export function LaneCounts({
  lanes,
  notRead = 0,
}: {
  lanes: Array<LaneSummary>
  /** Lockfiles and generated files no agent read. */
  notRead?: number
}) {
  return (
    <ul
      aria-label="Units by review lane"
      className="m-0 flex list-none flex-wrap gap-x-5 gap-y-2 p-0 text-[12.5px] text-ink-2"
    >
      {lanes.map((lane) => (
        <li
          key={lane.lane}
          className={cn(
            "inline-flex items-center gap-[7px]",
            lane.count === 0 && "text-ink-muted"
          )}
        >
          <LaneGlyph lane={lane.lane} className="size-[9px]" />
          {lane.name}
          <span
            className={cn("font-mono", lane.count > 0 ? "text-ink" : undefined)}
          >
            {lane.count}
          </span>
        </li>
      ))}
      {notRead > 0 && <NotReadCount count={notRead} />}
    </ul>
  )
}
