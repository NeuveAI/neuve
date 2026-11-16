/* ─────────────────────────────────────────────────────────
 * ANIMATION STORYBOARD — Review delivery (the phased choreography)
 *
 * The desk's and the settings preview's motion between delivery stops,
 * matching the canvas (DialTitle.dc.html, r16b). The "Jigs / Delivery
 * choreography" story tunes these values live on the real desk.
 *
 * One height movement per change. Layers never animate their own size: a
 * layer enters and leaves layout instantly while it is invisible. The
 * delivery stack (paragraph, toolbar, cards and diff) is the only thing
 * that changes size, once, old total → new total, in a single FLIP by
 * transform: the stack scales from its old height (top anchored), its
 * children are counter-scaled and slide to their new places, and arriving
 * layers sit at their target place. No height is ever animated, and nothing
 * is clipped (a clip makes the diff fall back to its skeleton).
 *
 *    0ms   leaving blocks fade out, last first, one step apart (27.5ms:
 *          TIMING.deliveryChildStagger / 2, the canvas's step) over
 *          TIMING.hint on EASE.emphasizedAccelerate; fade only, no drop.
 *          The card fades with its last block. The stack keeps its size.
 *  morph   MORPH_OVERLAP (13ms) before the last leaving block is out (it is
 *          then at most SHARE.morphStartOpacity, 30%, opaque; the overlap is
 *          derived from that), the stack morphs once on EASE.standard
 *          over TIMING.card (monotonic, no overshoot): leaving layers stop
 *          taking room (still fading in place), arriving layers step in,
 *          unseen
 *  77ms    (SHARE.contentStart, 75%, of the morph's travel): arriving
 *          blocks start in reading
 *          order, one step apart. Each fades over TIMING.hint and rises
 *          OFFSET.hint (2px) over TIMING.card, both EASE.standardDecelerate;
 *          the card fades with its first block. When the stack doesn't move,
 *          they start at the change.
 *
 * Blocks group as the canvas does: flow (heading, Before, After), terms
 * (heading and each term), the Guided card (heading, each row, the blast
 * radius with its rows, the suggested review).
 * A layer coming back before the morph fades back at once (no wait, no
 * step). A change mid-morph retargets from the stack's current visual size.
 * Reduced motion: no morph; the height snaps once and contents fade over
 * TIMING.reduced, together; a leaving layer fades where it was.
 * ───────────────────────────────────────────────────────── */

import * as React from "react"
import { atom, useAtomValueRawSync } from "jotai"
import type { PrimitiveAtom } from "jotai"
import { cubicBezier, spring } from "motion/react"
import type { ValueTransition } from "motion/react"

import { EASE, OFFSET, SHARE, TIMING, ms } from "@workspace/ui/lib/motion"

/** A spring in time terms, as DialKit's spring control reads and writes it. */
export interface TimeSpring {
  type: "spring"
  /** Seconds. */
  visualDuration: number
  bounce: number
}

/**
 * A SPRING token (stiffness, damping, mass 1) in time terms: the inverse of
 * motion's own visualDuration conversion (stiffness = (2π / (1.2 · v))²,
 * damping = 2 · (1 − bounce) · √stiffness), so both describe one spring.
 */
export function timeSpring(token: {
  stiffness: number
  damping: number
}): TimeSpring {
  const root = Math.sqrt(token.stiffness)
  // 1 − the damping ratio.
  const bounce = 1 - token.damping / (2 * root)
  return {
    type: "spring",
    visualDuration: (2 * Math.PI) / (1.2 * root),
    bounce,
  }
}

/** A cubic-bezier curve, as lib/motion.ts writes its EASE tokens. */
export type Bezier = readonly [number, number, number, number]

/** The morph as a motion transition. */
export function morphTransition(morph: PhasedParams["morph"]): ValueTransition {
  const [x1, y1, x2, y2] = morph.ease
  return { duration: morph.duration, ease: [x1, y1, x2, y2] }
}

/** Every value the phased choreography reads; the jig tunes each one. */
export interface PhasedParams {
  /** Share (0–1) of the morph's travel at which arriving blocks start. */
  contentStart: number
  /** Between blocks, arriving and leaving (ms). */
  stagger: number
  /** Px an arriving block rises from (over TIMING.card). Leaving blocks only fade. */
  offset: number
  /** Ms the morph starts before the last leaving block is out. */
  overlap: number
  /** The stack's one size change: a monotonic curve, never a spring. */
  morph: { duration: number; ease: Bezier }
  /** One block's fade (ms), in and out; the exit never outlasts its token. */
  content: number
}

/** The morph's monotonic curves (lib/motion.ts), for the jig's select. */
export const MORPH_CURVES = {
  standard: EASE.standard,
  standardDecelerate: EASE.standardDecelerate,
  emphasizedDecelerate: EASE.emphasizedDecelerate,
  iosOut: EASE.iosOut,
  inOut: EASE.inOut,
} as const

/**
 * How opaque the last leaving block may still be when the morph starts
 * (canvas r16b: at most 30%): the SHARE token.
 */
export const MORPH_START_OPACITY = SHARE.morphStartOpacity

/**
 * Ms the morph starts before the last leaving block is out, derived from the
 * exit fade's curve: emphasized accelerate over `exit` ms reaches
 * MORPH_START_OPACITY at 91% of its duration, so 13ms before its end over
 * TIMING.hint (canvas r16b).
 */
export function morphOverlap(exit: number, opacity = MORPH_START_OPACITY) {
  const [x1, y1, x2, y2] = EASE.emphasizedAccelerate
  const curve = cubicBezier(x1, y1, x2, y2)
  // Opacity runs 1 → 0 along the curve: find where 1 − curve reaches it.
  for (let step = 0; step <= 1000; step++)
    if (1 - curve(step / 1000) <= opacity)
      return Math.round(exit * (1 - step / 1000))
  return 0
}

/** The default overlap: the exit fade over TIMING.hint (13ms). */
export const MORPH_OVERLAP = morphOverlap(TIMING.hint)

/**
 * The canvas defaults (DialTitle.dc.html phDefaults, r16b): the morph on
 * EASE.standard over TIMING.card, arriving blocks from 75% of it, one step of
 * TIMING.deliveryChildStagger / 2 (27.5ms, the canvas's fallback for its
 * proposed --nv-dur-stagger-tight), a 2px rise (OFFSET.hint), exits fade only.
 */
export const PHASED_DEFAULTS: PhasedParams = {
  contentStart: SHARE.contentStart,
  stagger: TIMING.deliveryChildStagger / 2,
  offset: OFFSET.hint,
  overlap: MORPH_OVERLAP,
  morph: { duration: ms(TIMING.card), ease: MORPH_CURVES.standard },
  content: TIMING.hint,
}

/** The desk's choreography: the canvas defaults; the jig substitutes it. */
export const deliveryChoreographyAtom = atom<PhasedParams>(PHASED_DEFAULTS)

const ChoreographyAtomContext = React.createContext<PrimitiveAtom<PhasedParams>>(
  deliveryChoreographyAtom
)

/**
 * Stories substitute the atom the layers read (the desk owns its own jotai
 * store, so a story can't set the desk's copy of the default atom).
 */
export const DeliveryChoreographyAtomProvider = ChoreographyAtomContext.Provider

/** The choreography's values (the canvas defaults, or the jig's). */
export function usePhased(): PhasedParams {
  return useAtomValueRawSync(React.useContext(ChoreographyAtomContext))
}

/* ─── The leave timeline (ms from the change) ─────────────────────────── */

/** One block's exit: the content duration, never longer than the exit token. */
export function blockExit(params: PhasedParams) {
  return Math.min(params.content, TIMING.deliveryExit)
}

/**
 * A leaving layer with `blocks` blocks: when each block starts (last block
 * first, so delays[0] is the last block's), when its contents are out, and
 * when the stack may morph for it (the overlap before that).
 */
export function leaveTimeline(blocks: number, params: PhasedParams) {
  const count = Math.max(1, blocks)
  const delays = Array.from({ length: count }, (_, k) => k * params.stagger)
  const contentsOut = delays[count - 1]! + blockExit(params)
  return {
    delays,
    contentsOut,
    morphAt: Math.max(0, contentsOut - params.overlap),
  }
}

/**
 * A transition's progress (0 → 1, springs may overshoot) `ms` after it
 * starts: motion's own spring generator, or the easing curve over its
 * duration. Lets the morph (or a spring) be read by time.
 */
export function progressCurve(
  transition: ValueTransition
): (ms: number) => number {
  if (transition.type === "spring" || transition.duration === undefined) {
    const generator = spring({ keyframes: [0, 1], ...transition })
    return (time) => generator.next(time).value
  }
  const length = transition.duration * 1000
  const curve = transition.ease
  const ease = Array.isArray(curve)
    ? cubicBezier(
        Number(curve[0]),
        Number(curve[1]),
        Number(curve[2]),
        Number(curve[3])
      )
    : (x: number) => x
  return (time) => (length > 0 ? ease(Math.min(1, time / length)) : 1)
}

/** Ms until `transition` first covers `fraction` of its travel. */
export function timeToReach(transition: ValueTransition, fraction: number) {
  const progress = progressCurve(transition)
  // Half-millisecond steps over at most four seconds.
  for (let time = 0; time <= 4000; time += 0.5)
    if (progress(time) >= fraction) return time
  return 4000
}

/** Entering block `index` starts this long after the content start (ms). */
export function enterDelay(index: number, params: PhasedParams) {
  return index * params.stagger
}
