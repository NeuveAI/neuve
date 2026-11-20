/**
 * The phased delivery choreography (the jig's proposal): one morph per
 * change on a monotonic curve, leaving blocks out before it (less the
 * overlap), arriving blocks from a share of its travel; the app's default
 * stays today's choreography.
 */
import { describe, expect, test } from "bun:test"
import { cubicBezier } from "motion/react"

import { EASE, SHARE, SPRING, TIMING } from "@workspace/ui/lib/motion"
import {
  MORPH_CURVES,
  MORPH_OVERLAP,
  MORPH_START_OPACITY,
  PHASED_DEFAULTS,
  blockExit,
  enterDelay,
  leaveTimeline,
  morphOverlap,
  morphTransition,
  progressCurve,
  timeSpring,
  timeToReach,
} from "@workspace/ui/neuve/review-desk/delivery/delivery-choreography"

/** motion's own visualDuration → stiffness and damping conversion. */
function physics(spring: { visualDuration: number; bounce: number }) {
  const root = (2 * Math.PI) / (spring.visualDuration * 1.2)
  const stiffness = root * root
  return {
    stiffness,
    damping: 2 * (1 - spring.bounce) * Math.sqrt(stiffness),
  }
}

describe("phased delivery choreography", () => {
  test("its shares are the SHARE tokens; the step and overlap derive", () => {
    expect(PHASED_DEFAULTS.contentStart).toBe(SHARE.contentStart)
    expect(MORPH_START_OPACITY).toBe(SHARE.morphStartOpacity)
    expect(MORPH_OVERLAP).toBe(
      morphOverlap(TIMING.hint, SHARE.morphStartOpacity)
    )
    expect(PHASED_DEFAULTS.stagger).toBe(TIMING.deliveryChildStagger / 2)
    expect(
      timeToReach(timeSpring(SPRING.snappy), SHARE.chainThreshold)
    ).toBeCloseTo(127.5, 0)
  })

  test("the overlap: the last leaving block is ≤30% opaque at the morph", () => {
    expect(MORPH_OVERLAP).toBe(13)
    const [x1, y1, x2, y2] = EASE.emphasizedAccelerate
    const curve = cubicBezier(x1, y1, x2, y2)
    const at = (TIMING.hint - MORPH_OVERLAP) / TIMING.hint
    expect(1 - curve(at)).toBeLessThanOrEqual(0.31)
    expect(1 - curve(at - 0.02)).toBeGreaterThan(0.3)
  })

  test("every morph curve is monotonic: the stack never overshoots", () => {
    for (const ease of Object.values(MORPH_CURVES)) {
      const progress = progressCurve(
        morphTransition({ duration: PHASED_DEFAULTS.morph.duration, ease })
      )
      let previous = 0
      for (let time = 0; time <= 1000; time += 1) {
        const value = progress(time)
        expect(value).toBeGreaterThanOrEqual(previous - 1e-9)
        expect(value).toBeLessThanOrEqual(1 + 1e-9)
        previous = value
      }
      expect(previous).toBeCloseTo(1, 6)
    }
  })

  test("arriving blocks start at the share of the morph's travel", () => {
    const morph = morphTransition(PHASED_DEFAULTS.morph)
    const start = timeToReach(morph, PHASED_DEFAULTS.contentStart)
    expect(progressCurve(morph)(start)).toBeGreaterThanOrEqual(0.75)
    expect(progressCurve(morph)(start - 1)).toBeLessThan(0.75)
    expect(start).toBeLessThan(PHASED_DEFAULTS.morph.duration * 1000)
  })

  test("the time spring is the same spring as its token", () => {
    for (const spring of [SPRING.responsive, SPRING.snappy, SPRING.gentle]) {
      const back = physics(timeSpring(spring))
      expect(back.stiffness).toBeCloseTo(spring.stiffness, 6)
      expect(back.damping).toBeCloseTo(spring.damping, 6)
    }
  })

  test("leaving: blocks last-first, then the morph, the overlap early", () => {
    const timeline = leaveTimeline(4, PHASED_DEFAULTS)
    const step = PHASED_DEFAULTS.stagger
    expect(timeline.delays).toEqual([0, step, 2 * step, 3 * step])
    expect(blockExit(PHASED_DEFAULTS)).toBe(TIMING.hint)
    expect(timeline.contentsOut).toBe(3 * step + TIMING.hint)
    expect(timeline.morphAt).toBe(timeline.contentsOut - MORPH_OVERLAP)
    const huge = leaveTimeline(1, { ...PHASED_DEFAULTS, overlap: 10_000 })
    expect(huge.morphAt).toBe(0)
  })

  test("a block's exit never outlasts the exit token", () => {
    expect(blockExit({ ...PHASED_DEFAULTS, content: 600 })).toBe(
      TIMING.deliveryExit
    )
    expect(blockExit({ ...PHASED_DEFAULTS, content: 120 })).toBe(120)
  })

  test("arriving blocks stagger in reading order", () => {
    expect(
      [0, 1, 2].map((index) => enterDelay(index, PHASED_DEFAULTS))
    ).toEqual([0, 1, 2].map((index) => index * PHASED_DEFAULTS.stagger))
  })
})
