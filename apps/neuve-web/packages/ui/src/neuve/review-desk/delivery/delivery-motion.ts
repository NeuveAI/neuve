/* ─────────────────────────────────────────────────────────
 * Review delivery: the motion that isn't the stop-change choreography.
 *
 * Moving between delivery stops is the phased choreography
 * (delivery-choreography.ts, phased-layer.tsx: the canvas r16b model). This
 * file keeps what sits around it:
 *  click   a Source pin's excerpt drops 4px (220ms)
 *  click   "Why" in the agent's review card reveals its rows (rise 6px,
 *          TIMING.card fade, SPRING.responsive travel)
 *  click   "the agent's review" (an unlinked gathered scope): a smooth
 *          scroll brings the review line into view unless it is already
 *          fully visible; once arrived the line tints --nv-land, holds
 *          275ms, fades over 825ms (a diff landing), and focus lands on the
 *          review mark, so its provenance tooltip opens
 *  stop    a piece that comes and goes with a stop outside the phased layers
 *          (the "Why" chip) fades like a block: in from the arrivals' start,
 *          out over TIMING.hint
 * Reduced motion: a 150ms opacity tween; the review jump scrolls instantly
 * and its tint stays until the next pointer or key press. Not the reader's
 * move (the stored setting resolving a different stop after mount): snap.
 * ───────────────────────────────────────────────────────── */

import * as React from "react"
import { useReducedMotionConfig } from "motion/react"
import type { Transition } from "motion/react"

import {
  EASE,
  OFFSET,
  REDUCED_TRANSITION,
  SPRING,
  TIMING,
  ms,
} from "@workspace/ui/lib/motion"

export const EXCERPT = {
  offsetY: -OFFSET.card, // px the cited lines drop from
  enter: {
    duration: ms(TIMING.deliveryExcerpt),
    ease: EASE.emphasizedDecelerate,
  },
  exit: { duration: ms(TIMING.dockExit), ease: EASE.emphasizedAccelerate },
} as const

/**
 * The review line's arrival tint: the diff landing's values (hold, then an
 * accelerating fade), as opacity on a --nv-land layer behind the line.
 */
export const REVIEW_LANDING: { fade: Transition; opacity: Array<number> } = {
  fade: {
    duration: ms(TIMING.landHold + TIMING.landFade),
    times: [0, TIMING.landHold / (TIMING.landHold + TIMING.landFade), 1],
    ease: EASE.emphasizedAccelerate,
  },
  opacity: [1, 1, 0],
}

/**
 * How delivery layers move right now: the full storyboard, the reduced
 * 150ms fade, or instantly (a stop change the reader didn't make).
 */
export type DeliveryMotion = "full" | "reduced" | "instant"

/** True while the current stop isn't the reader's own move (the desk sets it). */
export const DeliveryInstantContext = React.createContext(false)

export function useDeliveryMotion(): DeliveryMotion {
  const reduce = useReducedMotionConfig()
  const instant = React.useContext(DeliveryInstantContext)
  return instant ? "instant" : reduce ? "reduced" : "full"
}

/** Click-driven pieces (an excerpt) ignore "instant": the reader did act. */
export function useReaderMotion(): Exclude<DeliveryMotion, "instant"> {
  return useReducedMotionConfig() ? "reduced" : "full"
}

const INSTANT: Transition = { duration: 0 }

/**
 * A piece that comes and goes with a stop outside the phased layers fades
 * like a block: in over TIMING.hint (standard decelerate) after `delayMs`
 * (the arrivals' start), out over TIMING.hint (emphasized accelerate).
 */
export function blockFade(
  mode: DeliveryMotion,
  delayMs: number
): { in: Transition; out: Transition } {
  if (mode === "instant") return { in: INSTANT, out: INSTANT }
  if (mode === "reduced")
    return { in: REDUCED_TRANSITION, out: REDUCED_TRANSITION }
  return {
    in: {
      duration: ms(TIMING.hint),
      ease: EASE.standardDecelerate,
      delay: ms(delayMs),
    },
    out: { duration: ms(TIMING.hint), ease: EASE.emphasizedAccelerate },
  }
}

/** A click-driven reveal (the "Why" rows): rises OFFSET.rise and fades in. */
export function revealProps(mode: Exclude<DeliveryMotion, "instant">) {
  const full = mode === "full"
  return {
    initial: full ? { opacity: 0, y: OFFSET.rise } : { opacity: 0 },
    animate: {
      opacity: 1,
      y: 0,
      transition: full
        ? {
            opacity: {
              duration: ms(TIMING.card),
              ease: EASE.standardDecelerate,
            },
            y: SPRING.responsive,
          }
        : REDUCED_TRANSITION,
    },
    exit: {
      opacity: 0,
      transition: full
        ? { duration: ms(TIMING.deliveryExit), ease: EASE.emphasizedAccelerate }
        : REDUCED_TRANSITION,
    },
  } as const
}
