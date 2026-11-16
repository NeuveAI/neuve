/* ─────────────────────────────────────────────────────────
 * NEUVE MOTION TOKENS
 *
 * Source: neuve-motion skill (neuve_effect motion-tokens.ts) and the motion
 * storyboard note on the approved review canvas. Every animated surface in
 * the UI package reads its values from here — no inline springs or
 * durations in JSX.
 *
 * CSS reads the same values: scripts/gen-motion-css.ts writes them to
 * styles/motion.css as --nv-* custom properties and Tailwind utilities
 * (duration-surface-tone, ease-standard, animate-skeleton…). Run
 * `bun run tokens:motion` after changing this file; a test fails if
 * motion.css is stale.
 *
 * Rules carried by these tokens:
 *   - springs first; tweens only where the storyboard names a curve
 *   - enter ≠ exit: decelerate in (220–300ms), accelerate out (≤200ms)
 *   - transform + opacity only, never blur or layout properties
 *   - reduced motion: opacity-only 150ms tween, or instant
 * ───────────────────────────────────────────────────────── */

export const SPRING = {
  /** Buttons, row press, micro hover. */
  snappy: { type: "spring", stiffness: 400, damping: 30 },
  /** General UI, tabs, panels (default). */
  responsive: { type: "spring", stiffness: 300, damping: 25 },
  /** Larger movements, dismissals, page and sheet transitions. */
  gentle: { type: "spring", stiffness: 200, damping: 20 },
} as const

export const EASE = {
  standard: [0.2, 0, 0, 1],
  standardDecelerate: [0, 0, 0, 1],
  standardAccelerate: [0.3, 0, 1, 1],
  emphasizedDecelerate: [0.05, 0.7, 0.1, 1],
  emphasizedAccelerate: [0.3, 0, 0.8, 0.15],
  /** iOS 26 web ease-out, used by the CSS-only hint and arrow nudges. */
  iosOut: [0.33, 1, 0.68, 1],
  /** CSS `ease-out` (motion's "easeOut"): scrims, pulses, reduced fades. */
  out: [0, 0, 0.58, 1],
  /** CSS `ease-in-out` (motion's "easeInOut"): breathing loops. */
  inOut: [0.42, 0, 0.58, 1],
  /** Constant rate: timelines and spinners. */
  linear: [0, 0, 1, 1],
} as const

/** Milliseconds. Interface Craft TIMING table for the review surfaces. */
export const TIMING = {
  surfaceTone: 120, // hover tone shift on rows, pins, buttons
  pressIn: 80, // press compress to SCALE.press (pins, buttons, the gutter "+")
  hint: 140, // L1 hover hint fade
  nudge: 140, // arrow nudges on hover (iOS ease-out)
  dimOthers: 160, // other margin items dim while a card is open (fork CSS)
  layerShift: 200, // margin items slide to their new place (diff fork CSS)
  lineTint: 140, // a pointed-at marker's lines tint in (diff fork CSS)
  card: 220, // L2 context card enter (emphasized decelerate)
  cardExit: 160, // L2 context card exit (accelerate)
  scrim: 160, // L3 sheet scrim fade
  sheetExit: 200, // L3 sheet exit (accelerate)
  pulseDelay: 280, // L3 cited fragment pulse waits for the sheet to land
  pulse: 900, // L3 cited fragment pulse length
  landHold: 275, // a jump's landing tint holds (the diff's fork CSS)
  landFade: 825, // then fades (emphasized accelerate); diff and review line
  dockRise: 240, // dock state enters
  dockExit: 120, // dock state leaves
  chevron: 200, // neighbor collapse chevron turn
  laneTone: 160, // lane bar dims the other lanes
  capture: 12000, // capture mini-player timeline
  linked: 160, // rail units sharing the pointed-at marker tone-shift
  swap: 180, // rail collapse / diff layout swap fade
  notice: 360, // new-commit notice drops in (emphasized decelerate)
  noticeExit: 160, // notice shrinks away to the corner pill
  message: 260, // a thread message arrives
  working: 1100, // "working" dots cycle (loop; off with reduced motion)
  detail: 240, // lineage row detail opens
  workingStagger: 180, // between "working" dots
  reduced: 150, // reduced-motion opacity tween
  contentFade: 160, // content replaces a skeleton
  skeleton: 1400, // skeleton blocks breathe, 1 → .55 → 1 (loop)
  workingSpin: 900, // lane glyph "working" spinner turn (still if reduced)
  pendingSpin: 1000, // connecting / starting spinner turn (still if reduced)
  railTone: 160, // rail rows and rail icon links tone-shift
  tick: 200, // rail progress ticks fill
  switchDim: 160, // unit switch: the old unit dims while the next loads
  switchWait: 150, // the dim waits this long, so quick switches never dim
  stuck: 160, // a sticky file header gains its stuck shadow
  stuckEnter: 180, // stuck-only header controls enter (emphasized decelerate)
  stuckExit: 140, // stuck-only header controls leave
  check: 140, // the Viewed checkbox fills
  // Review delivery: the phased choreography (review-desk/delivery/
  // delivery-choreography.ts) reads deliveryChildStagger (its step is half
  // of it, 27.5ms: the canvas's --ph-step fallback) and deliveryExit; the
  // morph is EASE.standard over TIMING.card, blocks fade over TIMING.hint, and
  // SHARE holds its proportions. The rest are the round-4 storyboard's
  // delays, retired from the code: canvas only (the Delivery,
  // DeliverySettings and DialTitle boards still read them through
  // tokens.css); remove each once no board does.
  deliveryLayer: 60, // canvas only: Explained layer opened
  deliveryGuided: 120, // canvas only: done-criteria card opened
  deliveryChildren: 100, // canvas only: children in an opening layer
  deliveryChildStagger: 55, // twice the phased block step
  deliveryNode: 160, // canvas only: flow boxes started
  deliveryNodeStagger: 70, // canvas only: between flow boxes
  deliveryMark: 220, // canvas only: met / not-met marks popped
  deliveryMarkStagger: 90, // canvas only: between marks
  deliveryVerdict: 620, // canvas only: suggested disposition rose, last
  // Review identity (round 4.2): an agent comment pin's ring and raised antenna.
  pinRing: 140, // ring fades in; the antenna rises on SPRING.snappy
  pinRingExit: 100, // ring fades out, quicker than it arrived
  deliveryExit: 200, // the longest a leaving block's fade may run
  deliveryExcerpt: 220, // a source chip's excerpt drops in at Guided
} as const

/** Pixels an element travels as it enters or leaves. */
export const OFFSET = {
  hint: 2, // L1 hover hint drops in
  nudge: 3, // arrow nudge on hover
  stuck: 3, // stuck-only header controls drop in
  label: 3, // a dial readout label rises
  card: 4, // cards, popovers, row details and reveals drop in
  rise: 6, // thread messages and the agent review's "Why" rows rise or slide
  lift: 8, // dock states and opened file code rise
  notice: 12, // new-commit notice drops in
  sheet: 24, // L3 source sheet slides in
} as const

/** Start scales (→ 1) for entering elements. */
export const SCALE = {
  press: 0.97, // anything pressed: pins, buttons, CTAs, gutter "+" (pressIn)
  enter: 0.98, // cards, popovers, the dock and the notice
  pop: 0.96, // chips, new pins and the parked notice pill (SPRING.snappy)
  collapse: 0.9, // the inline composer collapses toward its pin
  mark: 0.6, // canvas only: delivery marks popped (round-4 storyboard)
} as const

/**
 * Shares (0–1) of a movement, for the phased delivery choreography and the
 * delivery dial's bars (delivery-choreography.ts, delivery-dock-dial.tsx).
 */
export const SHARE = {
  contentStart: 0.75, // arriving blocks start at this share of the morph's travel
  chainThreshold: 0.85, // a bar starts when the previous one has made this share
  morphStartOpacity: 0.3, // the last leaving block's opacity when the morph starts
  fillStart: 0.9, // the dock glyph: a bar's fill starts when the bar has made this share of its height (round 7)
  dockBarPace: 0.85, // the dock glyph's bars and fills take this share of their tokens' durations and beats: about 15% quicker (round 7)
} as const

/** Opacity levels for dimmed and pulsing states. */
export const OPACITY = {
  dimOthers: 0.35, // other margin items while a card is open
  laneDim: 0.4, // the lanes not pointed at
  switching: 0.45, // the old unit while the next one loads
  livePulse: 0.35, // the live dot's low point
  workingLow: 0.3, // a "working" dot's low point
} as const

/**
 * Router view transitions (milliseconds and px). Sequential, never
 * overlapping: the old page is gone (exit) and a short empty beat passes
 * before the first new region appears; later regions follow 45ms apart.
 * The last region settles by 420ms. CSS: the --nv-vt-* properties in
 * styles/motion.css; names and stages: neuve/shared/view-transitions.ts.
 */
export const PAGE = {
  exit: 110, // old regions: opacity 1 → 0, y 0 → ∓4px (standard accelerate)
  exitOffset: 4, // px
  beat: 30, // nothing on screen but the chrome
  enter: 220, // new region: opacity 0 → 1, y ±8px → 0 (emphasized decelerate)
  enterLast: 190, // stage 3 is shorter so the sequence ends by 420ms
  enterOffset: 8, // px
  stagger: 45, // stage 1 at 140ms, stage 2 at 185ms, stage 3 at 230ms
  rail: 170, // rail: opacity only, 60ms after stage 2 (245ms → 415ms)
  railDelay: 245,
} as const

export const ms = (value: number) => value / 1000

/** A token key as CSS names it: surfaceTone → surface-tone. */
export const cssName = (key: string) =>
  key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)

/** TIMING keys CSS uses as delays; each gets a delay-<name> utility. */
export const CSS_DELAYS = ["switchWait"] as const satisfies ReadonlyArray<
  keyof typeof TIMING
>

/** CSS loops, as Tailwind animate-<name> utilities (keyframes: globals.css). */
export const CSS_ANIMATIONS = {
  skeleton: "nv-skeleton var(--nv-dur-skeleton) var(--nv-ease-in-out) infinite",
  "working-spin":
    "nv-spin var(--nv-dur-working-spin) var(--nv-ease-linear) infinite",
  "pending-spin":
    "nv-spin var(--nv-dur-pending-spin) var(--nv-ease-linear) infinite",
} as const

/**
 * EASE keys with no ease-<name> utility: Tailwind's own ease-out,
 * ease-in-out and ease-linear keep their curves (CSS reads var(--nv-ease-out)).
 */
const NO_EASE_UTILITY: ReadonlySet<string> = new Set(["out", "inOut", "linear"])

const springNames = Object.keys(SPRING).map((key) => `spring-${key}`)

/** The utility names styles/motion.css defines (duration-<name>, …). */
export const CSS_UTILITIES = {
  duration: [...Object.keys(TIMING), ...springNames].map(cssName),
  delay: CSS_DELAYS.map(cssName),
  ease: [
    ...Object.keys(EASE).filter((key) => !NO_EASE_UTILITY.has(key)),
    ...springNames,
  ].map(cssName),
  animate: Object.keys(CSS_ANIMATIONS),
} as const

/** An EASE curve as a CSS timing function. */
export const cssBezier = (curve: ReadonlyArray<number>) =>
  `cubic-bezier(${curve.join(", ")})`

/**
 * A SPRING as a CSS `linear()` easing and its settle time (ms), so CSS can
 * approximate the motion/react springs (within about 3% of motion's own
 * curve; settle times differ by up to 150ms). Unit step response
 * of x'' = -k(x - 1) - c·x' (mass 1), sampled every 1/60s until settled
 * (within 0.1%).
 */
export function cssSpring(spring: { stiffness: number; damping: number }) {
  const dt = 1 / 600
  let x = 0
  let v = 0
  let t = 0
  const samples: Array<number> = [0]
  let next = 1 / 60
  while (t < 2) {
    const a = -spring.stiffness * (x - 1) - spring.damping * v
    v += a * dt
    x += v * dt
    t += dt
    if (t >= next) {
      samples.push(x)
      next += 1 / 60
      if (Math.abs(x - 1) < 0.001 && Math.abs(v) < 0.01) break
    }
  }
  samples[samples.length - 1] = 1
  return {
    easing: `linear(${samples.map((value) => +value.toFixed(4)).join(", ")})`,
    duration: Math.round((samples.length - 1) * (1000 / 60)),
  }
}

/** Opacity-only fallback used whenever the user asks for reduced motion. */
export const REDUCED_TRANSITION = {
  type: "tween",
  duration: ms(TIMING.reduced),
  ease: EASE.out,
} as const

/** Tailwind-friendly CSS durations for CSS-only micro-interactions. */
export const CSS_TRANSITION = {
  tone: "transition-colors duration-surface-tone ease-standard motion-reduce:transition-none",
} as const
