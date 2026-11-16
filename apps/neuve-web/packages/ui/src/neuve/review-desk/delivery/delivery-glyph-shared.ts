/**
 * What the two delivery glyphs share (round 7): the title's
 * (delivery-title-dial.tsx) and the dock's (delivery-dock-dial.tsx). Their
 * dial's name, its popover layer, the tooltip that names the stop, and focus
 * moved to a glyph by script without opening that tooltip.
 */
import {
  EASE,
  OFFSET,
  SHARE,
  SPRING,
  TIMING,
  ms,
} from "@workspace/ui/lib/motion"
import { cn } from "@workspace/ui/lib/utils"
import { timeToReach } from "@workspace/ui/neuve/review-desk/delivery/delivery-choreography"

/**
 * The glyph's bars chain: each next bar starts when the one before it has
 * made SHARE.chainThreshold of its travel on SPRING.snappy (user-approved,
 * round 6), solved from the spring as the jig solves it.
 */
export const BAR_CHAIN = timeToReach(SPRING.snappy, SHARE.chainThreshold)

/** The dial group's name, and the start of the glyph's name. */
export const DIAL_LABEL = "Review delivery"

/** Gap between the glyph and its name above it (px). */
export const TIP_OFFSET = 6

/** The tooltip that names the stop: drops in over TIMING.hint. */
export const TIP = {
  initial: { opacity: 0, y: OFFSET.hint },
  animate: { opacity: 1, y: 0 },
  transition: { duration: ms(TIMING.hint), ease: EASE.iosOut },
} as const

/**
 * The dial's popover layer. The card's fade in and its fold run in CSS on
 * the popover's own open and closed states (Radix keeps it mounted until its
 * exit animation ends). Reduced motion: a 150ms fade either way, no scale.
 */
export const DIAL_LAYER = cn(
  // The dial brings its own card: the popover is only its layer.
  "z-40 w-auto gap-0 rounded-[10px] bg-transparent p-0 text-ink shadow-none ring-0",
  "data-[state=open]:animate-in data-[state=open]:duration-card data-[state=open]:ease-standard-decelerate data-[state=open]:fade-in-0",
  "data-[state=closed]:animate-out data-[state=closed]:duration-card-exit data-[state=closed]:ease-emphasized-accelerate data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-90",
  "motion-reduce:duration-reduced! motion-reduce:[--tw-ease:var(--nv-ease-out)]! motion-reduce:data-[state=closed]:zoom-out-100"
)

/**
 * Glyphs being focused by script (Escape, a press on the glyph from its
 * dial, or a hand-off between the title's glyph and the dock's): their name
 * was just heard, or the reader didn't move there, so that focus doesn't
 * show their tooltip.
 */
const quietGlyphs = new WeakSet<Element>()

/** Focuses a delivery glyph without opening its tooltip. */
export function focusGlyphQuietly(glyph: HTMLElement, ring: boolean) {
  quietGlyphs.add(glyph)
  glyph.focus({ focusVisible: ring, preventScroll: true })
  quietGlyphs.delete(glyph)
}

/** Whether `glyph` is being focused by focusGlyphQuietly right now. */
export const focusedQuietly = (glyph: Element | null) =>
  glyph !== null && quietGlyphs.has(glyph)
