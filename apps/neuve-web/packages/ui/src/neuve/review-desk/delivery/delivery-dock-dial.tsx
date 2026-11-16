/* ─────────────────────────────────────────────────────────
 * ANIMATION STORYBOARD — The delivery glyph in the dock (round 7,
 * DialScrolled.dc.html, B)
 *
 * While the title's glyph is out of view, the decision dock shows the same
 * glyph at its left. There is no travel between the two. The glyph lives in
 * an extension: a dock-coloured piece with the dock's radius on every
 * corner, under the body, its right side tucked one radius under the
 * body's left edge. Hidden, it rests fully under the body; shown, it reads
 * as a segment at the dock's left, the body's rounded corners making a
 * small notch between the two (that notch is the separation: no divider).
 * The extension and the glyph take turns, so the extension's slide and the
 * bars' rise read as two movements: the glyph itself never scales; each of
 * its four bars grows from its base in turn, and a bar's fill follows once
 * that bar is nearly up. Once the change is over, the whole dock re-centres
 * in one movement. The bar's drop shadow follows both pieces. n is the
 * stop's filled bars (Facts 1 … Guided 4).
 *
 * The bars and fills run at BAR_PACE: about 15% quicker than their tokens.
 *
 * title scrolls out: the glyph arrives (all from the dock's left)
 *    0ms   the extension slides out from behind the body (TIMING.card,
 *          EASE.standard, transform only)
 *  220ms   ARRIVE_AT (the extension has landed): the first bar grows from
 *          its base, scaleY 0 → 1 on SPRING.snappy
 *  +108.375ms each  the next bar, when the one before has made
 *          SHARE.chainThreshold (DOCK_BAR_CHAIN): bar i at ARRIVE_AT +
 *          i × DOCK_BAR_CHAIN
 *  +119ms  a filled bar's fill rises once its bar has made SHARE.fillStart
 *          of its height (FILL_AT), on SPRING.snappy with its fade
 *          (TIMING.hint)
 *  220 + max(4 × 108.375, n × 108.375 + 119)ms  recentreIn (the last bar
 *          and the last fill have made their chain share): the dock moves
 *          right by half the extension's visible width, so the two are
 *          centred together (TIMING.card, EASE.standard)
 *
 * title scrolls back: the same, last first, at twice the speed
 * (EXIT_TEMPO: the dock's own exit-to-rise ratio, a half)
 *    0ms   the last bar's fill falls (if filled), then its bar shrinks
 *          SHRINK_AFTER_FILL (59.5ms) later; each bar before it a
 *          FALL_CHAIN (54.1875ms) later (TIMING.dockExit at BAR_PACE,
 *          102ms, standard accelerate)
 *  222.06ms  glyphOut (the first bar starts shrinking): the glyph fades
 *          over the same 102ms (emphasized accelerate); hidden once out
 *  324.06ms  extensionBack (the bars are down): the extension slides back
 *          under the body (TIMING.cardExit, EASE.standard)
 *  484.06ms  recentreOut (the extension is back): the dock moves back to
 *          centre (TIMING.cardExit, EASE.standard)
 *
 * quick reversal  everything turns back from where it is, with no beat:
 *          the CSS transitions and the bars' fall; the bars rise again
 *          only when the glyph comes from nothing
 * reduced motion  everything changes in one step
 *
 * The dial opens above the glyph (the shadcn Popover, in place) and folds
 * like the title's: a press outside, Escape (topmost layer first, focus
 * back to this glyph) or the glyph again. Choosing a stop never folds it.
 * ───────────────────────────────────────────────────────── */

import * as React from "react"
import { atom, useAtomValueRawSync, useSetAtom, useStore } from "jotai"
import { motion, useReducedMotionConfig } from "motion/react"
import { Tooltip as TooltipPrimitive } from "radix-ui"

import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "@workspace/ui/components/popover"
import {
  EASE,
  REDUCED_TRANSITION,
  SCALE,
  SHARE,
  SPRING,
  TIMING,
  cssBezier,
  cssSpring,
} from "@workspace/ui/lib/motion"
import { cn } from "@workspace/ui/lib/utils"
import {
  DELIVERY_STOPS,
  DELIVERY_STOP_LABEL,
} from "@workspace/ui/neuve/shared/delivery"
import type { DeliveryStop } from "@workspace/ui/neuve/shared/delivery"
import {
  DeliveryDial,
  DeliveryTicks,
} from "@workspace/ui/neuve/shared/delivery-dial"
import {
  BAR_CHAIN,
  DIAL_LABEL,
  DIAL_LAYER,
  TIP,
  TIP_OFFSET,
  focusGlyphQuietly,
  focusedQuietly,
} from "@workspace/ui/neuve/review-desk/delivery/delivery-glyph-shared"
import { timeToReach } from "@workspace/ui/neuve/review-desk/delivery/delivery-choreography"
import {
  deliveryDockDialCarryAtom,
  deliveryGlyphFocusAtom,
} from "@workspace/ui/neuve/review-desk/delivery/delivery-state"

/* ─── Timing (lib/motion.ts) ──────────────────────────────────────────── */

/** The first bar grows in once the extension has landed: 220ms. */
export const ARRIVE_AT = TIMING.card

/** The glyph's bars: four, filled up to the stop. */
const BARS = 4

/**
 * The dock glyph's bars and fills run about 15% quicker than their tokens
 * (SHARE.dockBarPace, the user's call, round 7): every duration and beat of
 * theirs, both ways, is scaled by it. The springs keep their shape, only
 * quicker.
 */
const BAR_PACE = SHARE.dockBarPace

/**
 * The dock's bars chain as the title's do (BAR_CHAIN, each when the one
 * before has made SHARE.chainThreshold), at BAR_PACE: 108.375ms.
 */
export const DOCK_BAR_CHAIN = BAR_CHAIN * BAR_PACE

/**
 * A bar's fill starts once the bar has made SHARE.fillStart of its height
 * on SPRING.snappy, at BAR_PACE: 119ms after the bar starts.
 */
export const FILL_AT = timeToReach(SPRING.snappy, SHARE.fillStart) * BAR_PACE

/**
 * Leaving runs at twice the speed: the dock's own exit-to-rise ratio,
 * TIMING.dockExit / TIMING.dockRise (a half). The beats between the bars
 * and their fills are halved.
 */
const EXIT_TEMPO = TIMING.dockExit / TIMING.dockRise

/** The bars leave this far apart, the last first: DOCK_BAR_CHAIN at EXIT_TEMPO. */
export const FALL_CHAIN = DOCK_BAR_CHAIN * EXIT_TEMPO

/** A bar shrinks this long after its fill starts falling: FILL_AT at EXIT_TEMPO. */
export const SHRINK_AFTER_FILL = FILL_AT * EXIT_TEMPO

/** The filled bars at a stop: Facts 1, Briefed 2, Explained 3, Guided 4. */
export const filledBars = (stop: DeliveryStop) =>
  DELIVERY_STOPS.indexOf(stop) + 1

/**
 * When the first bar starts shrinking: the glyph fades then, over the bar's
 * own shrink (ms from the change).
 */
const GLYPH_OUT = (BARS - 1) * FALL_CHAIN + SHRINK_AFTER_FILL
/** A bar's or a fill's fall, and the glyph's fade: TIMING.dockExit at BAR_PACE. */
const BAR_FALL = TIMING.dockExit * BAR_PACE
/** The extension slides back once the bars are down. */
const EXTENSION_BACK = GLYPH_OUT + BAR_FALL

/**
 * The beats (ms from the change). Only the arrival's re-centre depends on
 * the stop; the CSS reads the same sum (DOCK_RECENTRE), from --dock-bars.
 */
export function dockGlyphBeats(stop: DeliveryStop) {
  return {
    /**
     * The dock re-centres once the last bar and the last fill have made
     * their chain share.
     */
    recentreIn:
      ARRIVE_AT +
      Math.max(
        BARS * DOCK_BAR_CHAIN,
        filledBars(stop) * DOCK_BAR_CHAIN + FILL_AT
      ),
    glyphOut: GLYPH_OUT,
    extensionBack: EXTENSION_BACK,
    /** The dock re-centres once the extension is back. */
    recentreOut: EXTENSION_BACK + TIMING.cardExit,
  }
}

/**
 * Set on the dock bar and the extension for the instant a quick reversal
 * starts its transitions: every delay is zero then (DOCK_RECENTRE,
 * EXTENSION, GLYPH_BOX).
 */
const REVERSING = "data-dock-reversing"

/** The bars and their fills rise on SPRING.snappy, in CSS terms, at BAR_PACE. */
const SNAPPY = cssSpring(SPRING.snappy)
const BAR_RISE = { ...SNAPPY, duration: SNAPPY.duration * BAR_PACE }
/** A fill's own fade as it rises (as on the title glyph), at BAR_PACE. */
const TICK_FADE = {
  duration: TIMING.hint * BAR_PACE,
  easing: cssBezier(EASE.standard),
}
/** A bar or a fill on the way out. */
const TICK_FALL = {
  duration: BAR_FALL,
  easing: cssBezier(EASE.standardAccelerate),
}
/** A bar grows from its base, and shrinks back to it. */
const GROW: Array<Keyframe> = [
  { transform: "scaleY(0)", transformOrigin: "50% 100%" },
  { transform: "scaleY(1)", transformOrigin: "50% 100%" },
]
const SHRINK: Array<Keyframe> = [...GROW].reverse()

/** The glyph's bars (its ticks), first to last, each with its fill. */
const ticksOf = (glyph: HTMLElement) =>
  Array.from(
    glyph.querySelectorAll<HTMLElement>("[data-delivery-dock-trigger] i")
  ).map((tick) => ({
    tick,
    fill: tick.querySelector<HTMLElement>(":scope > b")!,
    filled: tick.hasAttribute("data-filled"),
  }))

/* ─── Sizes (DialScrolled.dc.html `.dext`) ────────────────────────────── */

/** The glyph's box (px), as the title's (size-8). */
const GLYPH = 32
/** The dock's corner radius (px): the extension's too, and its tuck. */
const DOCK_RADIUS = 14
/**
 * The notch the body's rounded corners leave over the extension reads as
 * the cell's edge at its middle, half the radius past the body's edge: 7px.
 */
const NOTCH = DOCK_RADIUS / 2
/**
 * The space either side of the glyph as it reads (px): from the
 * extension's left edge, and to the middle of the notch (3px to the body's
 * edge, then the notch's 7px).
 */
const GLYPH_GAP = 10

/**
 * The extension's visible width: the glyph with its gap either side, less
 * the notch half that the body covers: 2 × 10 + 32 − 7 = 45px.
 */
const EXTENSION_VISIBLE = 2 * GLYPH_GAP + GLYPH - NOTCH

/**
 * How far the dock moves right while the glyph is in: half the extension's
 * visible width, so the two are centred together: 22.5px.
 */
export const DOCK_GLYPH_SHIFT = EXTENSION_VISIBLE / 2

/**
 * The beats and sizes above as CSS custom properties, for the extension's
 * transitions and the dock bar's re-centring: one source, these constants.
 * The decision dock sets them on its wrapper (DecisionDock), so the bar and
 * the extension both read them.
 */
export const DOCK_GLYPH_VARS = {
  "--dock-glyph-in": `${ARRIVE_AT}ms`,
  "--dock-bar-chain": `${DOCK_BAR_CHAIN}ms`,
  "--dock-bar-span": `${BARS * DOCK_BAR_CHAIN}ms`,
  "--dock-bar-fall": `${BAR_FALL}ms`,
  "--dock-fill-at": `${FILL_AT}ms`,
  "--dock-glyph-out": `${GLYPH_OUT}ms`,
  "--dock-ext-back": `${EXTENSION_BACK}ms`,
  "--dock-recentre-out": `${EXTENSION_BACK + TIMING.cardExit}ms`,
  "--dock-ext-visible": `${EXTENSION_VISIBLE}px`,
  "--dock-glyph-gap": `${GLYPH_GAP}px`,
  "--dock-radius": `${DOCK_RADIUS}px`,
  "--dock-glyph-shift": `${DOCK_GLYPH_SHIFT}px`,
} as React.CSSProperties

/**
 * The dock bar's re-centring, for DOCK_BAR: it moves right by
 * DOCK_GLYPH_SHIFT while its extension is shown (after the last bar has
 * risen) and back once the extension is back. `translate`, so it composes
 * with the dock state's own transform (its rise). The arrival's re-centre
 * depends on the stop (dockGlyphBeats): the bar reads --dock-bars from its
 * extension's stop, then the same sum.
 */
export const DOCK_RECENTRE = cn(
  "has-[>[data-dock-delivery][data-stop=briefed]]:[--dock-bars:2] has-[>[data-dock-delivery][data-stop=explained]]:[--dock-bars:3] has-[>[data-dock-delivery][data-stop=facts]]:[--dock-bars:1] has-[>[data-dock-delivery][data-stop=guided]]:[--dock-bars:4]",
  "[--dock-recentre-in:calc(var(--dock-glyph-in)+max(var(--dock-bar-span),var(--dock-bars)*var(--dock-bar-chain)+var(--dock-fill-at)))]",
  "transition-[translate] delay-(--dock-recentre-out) duration-card-exit ease-standard",
  "has-[>[data-dock-delivery][data-shown]]:translate-x-(--dock-glyph-shift) has-[>[data-dock-delivery][data-shown]]:delay-(--dock-recentre-in) has-[>[data-dock-delivery][data-shown]]:duration-card",
  "data-dock-reversing:delay-0!",
  "motion-reduce:transition-none"
)

/* ─── The extension (DialScrolled.dc.html `.dext`) ────────────────────── */

/**
 * The extension: under the dock's body (-z-2; the body's fill is -z-1),
 * its right side tucked one radius under the body's left edge, with the
 * dock's radius on every corner. As wide as its visible part and the tuck;
 * the glyph sits GLYPH_GAP from its left edge, which centres it, as it
 * reads, between that edge and the middle of the notch (NOTCH). Hidden, it
 * slides right by its width less the tuck, so it rests fully under the
 * body, its left corners on the body's. Shown, the body's rounded corners leave a small notch at the
 * seam: the two read as segments. Inert while hidden: the glyph can't be
 * focused or read.
 */
const EXTENSION = cn(
  "group/ext pointer-events-auto absolute inset-y-0 right-[calc(100%-var(--dock-radius))] -z-2 flex w-[calc(var(--dock-ext-visible)+var(--dock-radius))] items-center justify-start rounded-(--dock-radius) bg-dock pl-(--dock-glyph-gap)",
  "translate-x-[calc(100%-var(--dock-radius))] transition-[translate] delay-(--dock-ext-back) duration-card-exit ease-standard",
  "data-dock-reversing:delay-0! data-shown:translate-x-0 data-shown:delay-0 data-shown:duration-card",
  "motion-reduce:transition-none"
)

/**
 * The glyph: never scaled. Arriving, it shows at once and its bars carry
 * the motion (each held at scaleY 0 until its beat). Leaving, it fades over
 * its first bar's shrink (glyphOut), and on a quick reversal at once.
 */
const GLYPH_BOX = cn(
  "inline-flex",
  "invisible opacity-0",
  "[transition:opacity_var(--dock-bar-fall)_var(--nv-ease-emphasized-accelerate)_var(--dock-glyph-out),visibility_var(--dock-bar-fall)_linear_var(--dock-glyph-out)]",
  // Arriving, its own fade is unseen (every bar is at scaleY 0 until
  // ARRIVE_AT); it is there so a quick reversal back in turns the exit's
  // fade back instead of snapping.
  "group-data-shown/ext:visible group-data-shown/ext:opacity-100 group-data-shown/ext:[transition:opacity_var(--dock-bar-fall)_var(--nv-ease-standard-decelerate),visibility_0s]",
  // A quick reversal: at once. Leaving, it still hides only once its fade
  // is over: visibility stays visible for its whole run.
  "group-data-dock-reversing/ext:delay-0!",
  "motion-reduce:transition-none! motion-reduce:group-data-shown/ext:transition-none!"
)

/* ─── Placement (DialScrolled.dc.html `.ddial.above`) ─────────────────── */

/**
 * The dial's bottom sits this far above the glyph's top (px): 14px, which is
 * 6px above the dock (the glyph sits 8px inside it).
 */
const DIAL_GAP = 14
/** The dial's left edge sits this far left of the glyph's (px): 6px. */
const DIAL_INSET = 6
/** The dial grows from and folds toward the glyph's centre. */
const DIAL_ORIGIN = `${DIAL_INSET + GLYPH / 2}px calc(100% + ${DIAL_GAP + GLYPH / 2}px)`

/**
 * The glyph on the dock: the title glyph's shape in the dock's colours.
 * --dock-muted at rest (its hollow ticks too, 3:1 or better on the dock,
 * its hover and its line); --dock-hover fill and --dock-fg on hover and
 * keyboard focus; open, a step further: --dock-line fill, --dock-fg ticks
 * and a 1px --dock-muted inset edge, so open never reads as rest or hover.
 * The ring is the inverse one (the dock's data-surface scope). A popup
 * trigger, so no press compress.
 */
const TRIGGER = cn(
  "relative inline-flex size-8 items-center justify-center rounded-sm text-dock-muted [--tick-hollow:var(--nv-dock-muted)]",
  "transition-colors duration-surface-tone ease-standard motion-reduce:transition-none",
  // 44px hit area around the 32px glyph.
  "after:absolute after:top-1/2 after:left-1/2 after:size-11 after:-translate-1/2",
  "not-aria-expanded:hover:bg-dock-hover not-aria-expanded:hover:text-dock-fg not-aria-expanded:focus-visible:bg-dock-hover not-aria-expanded:focus-visible:text-dock-fg",
  "aria-expanded:bg-dock-line aria-expanded:text-dock-fg aria-expanded:shadow-[inset_0_0_0_1px_var(--nv-dock-muted)]",
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
)

/** The title's glyph in the same desk. */
function titleGlyphOf(element: HTMLElement) {
  return (
    element
      .closest("[data-desk-scroll]")
      ?.querySelector<HTMLElement>(
        "[data-delivery-title-dial] [data-delivery-trigger]"
      ) ?? null
  )
}

/* ─── The glyph in the dock ───────────────────────────────────────────── */

export interface DeliveryDockDialProps {
  /** Whether the title's glyph is out of view (deliveryTitleAwayAtom). */
  shown: boolean
  value: DeliveryStop
  onChange: (stop: DeliveryStop) => void
  /** The stops the unit offers; the rest are disabled (DeliveryDial). */
  offered?: ReadonlyArray<DeliveryStop>
}

/**
 * Review delivery in the decision dock (round 7, B): the title's glyph and
 * dial, at the dock's left while the title's glyph is out of view. Render it
 * in the dock bar, which draws its body fill at -z-1 and its shadow as a
 * drop-shadow filter (DOCK_BAR), so the extension slides out from under the
 * body and the shadow follows both.
 */
export function DeliveryDockDial({
  shown,
  value,
  onChange,
  offered,
}: DeliveryDockDialProps) {
  const reduce = useReducedMotionConfig() ?? false
  const store = useStore()
  const openAtom = React.useMemo(() => atom(false), [])
  const tipAtom = React.useMemo(() => atom(false), [])
  // Reopened in a new dock bar (see deliveryDockDialCarryAtom): the dial is
  // already open, so it doesn't play its opening again.
  const carriedAtom = React.useMemo(() => atom(false), [])
  // Read with useSyncExternalStore: the mount's layout effect may open the
  // dial (a carried one), and that write must reach this first render.
  const open = useAtomValueRawSync(openAtom)
  const tip = useAtomValueRawSync(tipAtom)
  const carried = useAtomValueRawSync(carriedAtom)
  const setOpen = useSetAtom(openAtom)
  const setTip = useSetAtom(tipAtom)
  const setCarried = useSetAtom(carriedAtom)
  const dialId = React.useId()
  const extension = React.useRef<HTMLSpanElement>(null)
  const box = React.useRef<HTMLSpanElement>(null)
  const trigger = React.useRef<HTMLButtonElement>(null)
  const floating = React.useRef<HTMLDivElement>(null)
  /** The ticks' rise on arrival, and their fall on the way out. */
  const rises = React.useRef<Array<Animation>>([])
  const falls = React.useRef<Array<Animation>>([])
  const byKeyboard = React.useRef(false)
  const wantsFocus = React.useRef(false)
  /** Focus is in the extension (the glyph or its dial), and its ring. */
  const focusIn = React.useRef<{ ring: boolean } | null>(null)
  const focusInDial = React.useRef<{ ring: boolean } | null>(null)
  const closedBy = React.useRef<"escape" | null>(null)
  const mounted = React.useRef(false)
  /**
   * The dock's own transitions in flight, counted by element and property:
   * the bar's re-centre, the extension's slide, the glyph's fade.
   * Counted (not a set) because a reversed transition's cancel and its
   * replacement's run may come in either order.
   */
  const inFlight = React.useRef(new Map<string, number>())

  const name = `${DIAL_LABEL}: ${DELIVERY_STOP_LABEL[value]}`

  const stopRises = () => {
    for (const run of rises.current) run.cancel()
    rises.current = []
  }
  const stopFalls = () => {
    for (const run of falls.current) run.cancel()
    falls.current = []
  }
  /** The fall turns back from where it is; a bar not yet falling stays. */
  const turnFallsBack = () => {
    falls.current = falls.current.filter((run) => {
      if (run.effect?.getComputedTiming().progress == null) {
        run.cancel()
        return false
      }
      run.reverse()
      return true
    })
  }

  // Effect: counts the dock's own CSS transitions as they run and end (DOM transition events on the bar, an external system), so a change can tell whether the last one is still moving.
  React.useLayoutEffect(() => {
    const ext = extension.current
    const glyph = box.current
    const bar = ext?.parentElement
    if (!ext || !glyph || !bar) return
    const counts = inFlight.current
    const key = ({ target, propertyName }: TransitionEvent) => {
      const part =
        target === bar
          ? "bar"
          : target === ext
            ? "extension"
            : target === glyph
              ? "glyph"
              : null
      return part && `${part} ${propertyName}`
    }
    const run = (event: TransitionEvent) => {
      const at = key(event)
      if (at) counts.set(at, (counts.get(at) ?? 0) + 1)
    }
    const done = (event: TransitionEvent) => {
      const at = key(event)
      if (!at) return
      const left = (counts.get(at) ?? 0) - 1
      if (left > 0) counts.set(at, left)
      else counts.delete(at)
    }
    bar.addEventListener("transitionrun", run)
    bar.addEventListener("transitionend", done)
    bar.addEventListener("transitioncancel", done)
    return () => {
      bar.removeEventListener("transitionrun", run)
      bar.removeEventListener("transitionend", done)
      bar.removeEventListener("transitioncancel", done)
      counts.clear()
    }
  }, [])

  // Effect: hands focus between the title's glyph and this one, and runs the bars' and fills' rise and fall (Web Animations, an external system) as the glyph arrives and leaves; the extension's own motion is CSS transitions.
  React.useLayoutEffect(() => {
    const glyph = box.current
    if (!glyph) return
    const first = !mounted.current
    mounted.current = true
    // A change while the last one is still moving (any of the dock's own
    // transitions in flight) turns back from where things are: it starts
    // every transition at once, with no beat. The delays are set to zero for
    // the transitions this change starts (read the styles to start them),
    // then restored; a running transition keeps the timing it started with.
    // A mount is never a change: a fresh dock bar has nothing in flight.
    const reversing = !first && !reduce && inFlight.current.size > 0
    const ext = extension.current
    const bar = ext?.parentElement
    if (reversing && ext && bar) {
      for (const element of [bar, ext]) element.toggleAttribute(REVERSING, true)
      for (const element of [bar, ext, glyph])
        void getComputedStyle(element).opacity
      void getComputedStyle(bar).translate
      void getComputedStyle(ext).translate
      for (const element of [bar, ext]) element.removeAttribute(REVERSING)
      turnFallsBack()
    }
    if (!shown) {
      if (first) return
      // The bars leave, the last first: its fill falls, then the bar
      // shrinks; the glyph fades over the first bar's shrink (GLYPH_BOX).
      // A quick reversal starts no fall: the bars go on as they were (still
      // rising, if they were) under the glyph's fade.
      if (!reduce && !reversing) {
        stopRises()
        stopFalls()
        falls.current = ticksOf(glyph)
          .reverse()
          .flatMap(({ tick, fill, filled }, index) => {
            const delay = index * FALL_CHAIN
            const shrink = tick.animate(SHRINK, {
              ...TICK_FALL,
              delay: delay + SHRINK_AFTER_FILL,
              fill: "forwards",
            })
            if (!filled) return [shrink]
            return [
              fill.animate(
                [{ transform: "scaleY(1)" }, { transform: "scaleY(0)" }],
                { ...TICK_FALL, delay, fill: "forwards" }
              ),
              fill.animate([{ opacity: 1 }, { opacity: 0 }], {
                ...TICK_FALL,
                delay,
                fill: "forwards",
              }),
              shrink,
            ]
          })
      }
      // Leaving: the dial goes with the glyph. Focus in either goes back to
      // the title's glyph (quietly; with the ring if it showed one here).
      const active = document.activeElement
      const inside =
        (active instanceof HTMLElement &&
          (extension.current?.contains(active) ?? false)) ||
        focusIn.current !== null
      const ring =
        (inside && active instanceof HTMLElement
          ? active.matches(":focus-visible")
          : false) ||
        (focusIn.current?.ring ?? false)
      setOpen(false)
      setTip(false)
      setCarried(false)
      focusIn.current = null
      focusInDial.current = null
      if (inside) {
        const title = extension.current && titleGlyphOf(extension.current)
        if (title) focusGlyphQuietly(title, ring)
      }
      return
    }
    // The title's dial closed as its glyph left, with focus in it: focus
    // comes here (it waited on the title's glyph meanwhile).
    const hand = store.get(deliveryGlyphFocusAtom)
    if (hand?.to === "dock") {
      store.set(deliveryGlyphFocusAtom, null)
      const active = document.activeElement
      if (
        active === null ||
        active === document.body ||
        active === titleGlyphOf(glyph)
      )
        focusGlyphQuietly(trigger.current!, hand.ring)
    }
    if (first) {
      // A stop change swapped the dock bar with this dial open: it stays
      // open, in the new bar.
      const carry = store.get(deliveryDockDialCarryAtom)
      if (carry) {
        store.set(deliveryDockDialCarryAtom, null)
        byKeyboard.current = carry.focus?.ring ?? false
        wantsFocus.current = carry.focus !== null
        setCarried(true)
        setOpen(true)
      }
      // In the bar from its first render: no arrival of its own.
      return
    }
    // The bars rise only on an arrival from nothing: a quick reversal
    // turns back from where things are and never replays them. Reduced
    // motion: no rise, and nothing left over from an exit.
    if (reversing) return
    stopRises()
    stopFalls()
    if (reduce) return
    // Each bar grows from its base in turn; a filled bar's fill rises once
    // the bar is nearly up (FILL_AT).
    rises.current = ticksOf(glyph).flatMap(({ tick, fill, filled }, index) => {
      const delay = ARRIVE_AT + index * DOCK_BAR_CHAIN
      const grow = tick.animate(GROW, { ...BAR_RISE, delay, fill: "backwards" })
      if (!filled) return [grow]
      return [
        grow,
        fill.animate([{ transform: "scaleY(0)" }, { transform: "scaleY(1)" }], {
          ...BAR_RISE,
          delay: delay + FILL_AT,
          fill: "backwards",
        }),
        fill.animate([{ opacity: 0 }, { opacity: 1 }], {
          ...TICK_FADE,
          delay: delay + FILL_AT,
          fill: "backwards",
        }),
      ]
    })
  }, [shown])

  // Effect: ends the ticks' rise and fall (Web Animations, an external system) on unmount; an open dial carries over to the next dock bar.
  React.useLayoutEffect(
    () => () => {
      stopRises()
      stopFalls()
      if (store.get(openAtom)) {
        const carry = { focus: focusInDial.current }
        store.set(deliveryDockDialCarryAtom, carry)
        // Only a glyph mounting in this same commit takes it.
        queueMicrotask(() => {
          if (store.get(deliveryDockDialCarryAtom) === carry)
            store.set(deliveryDockDialCarryAtom, null)
        })
      }
    },
    []
  )

  // A stop change hands the ticks to their own spring: the arrival's rise
  // or the exit's fall would hold them where it is meanwhile.
  const firstStop = React.useRef(value)
  // Effect: stops the ticks' arrival rise and exit fall (Web Animations, an external system) when the stop changes.
  React.useLayoutEffect(() => {
    if (firstStop.current === value) return
    firstStop.current = value
    stopRises()
    stopFalls()
  }, [value])

  const takeFocus = () => {
    if (!wantsFocus.current || !floating.current) return
    wantsFocus.current = false
    floating.current
      .querySelector<HTMLInputElement>("input:checked")
      ?.focus({ focusVisible: byKeyboard.current, preventScroll: true })
  }

  /** Folds the dial; Escape, or the glyph with focus in the dial, refocus it. */
  const fold = (keyboard: boolean) => {
    const inDial = floating.current?.contains(document.activeElement) ?? false
    setOpen(false)
    setTip(false)
    setCarried(false)
    const glyph = trigger.current
    if (!glyph || (!keyboard && !inDial)) return
    focusGlyphQuietly(glyph, keyboard)
  }

  /** A press or focus outside: folded, and focus stays where it went. */
  const dismiss = () => {
    setOpen(false)
    setTip(false)
    setCarried(false)
  }

  return (
    <span
      ref={extension}
      data-dock-delivery=""
      data-shown={shown || undefined}
      // The bar reads the stop's beats from it (DOCK_RECENTRE).
      data-stop={value}
      inert={!shown}
      className={EXTENSION}
      onFocus={(event) => {
        focusIn.current = { ring: event.target.matches(":focus-visible") }
      }}
      onBlur={(event) => {
        // Focus went somewhere real outside; a drop to the body (inert)
        // keeps the record for the hand-off.
        const next = event.relatedTarget
        if (next && !event.currentTarget.contains(next)) focusIn.current = null
      }}
    >
      <TooltipPrimitive.Provider delayDuration={0}>
        <Popover
          open={open}
          onOpenChange={(next) => {
            if (next) return
            // Radix closes it: Escape, or a press or focus outside it.
            if (closedBy.current === "escape") fold(true)
            else dismiss()
            closedBy.current = null
          }}
        >
          <span ref={box} data-dock-delivery-glyph="" className={GLYPH_BOX}>
            <TooltipPrimitive.Root
              open={tip && !open && shown}
              onOpenChange={(next) => {
                if (next && (open || focusedQuietly(trigger.current))) return
                setTip(next)
              }}
            >
              <TooltipPrimitive.Trigger asChild>
                <PopoverAnchor asChild>
                  <button
                    ref={trigger}
                    type="button"
                    data-delivery-dock-trigger=""
                    aria-label={name}
                    aria-expanded={open}
                    aria-controls={dialId}
                    // The tooltip says the name; as a description it would
                    // be read twice.
                    aria-describedby={undefined}
                    className={TRIGGER}
                    onClick={(event) => {
                      if (open) return fold(event.detail === 0)
                      // Enter or Space click with detail 0.
                      byKeyboard.current = event.detail === 0
                      wantsFocus.current = true
                      focusInDial.current = null
                      setTip(false)
                      setCarried(false)
                      setOpen(true)
                    }}
                  >
                    <DeliveryTicks
                      stop={value}
                      size="title"
                      animated
                      barDelay={BAR_CHAIN}
                    />
                  </button>
                </PopoverAnchor>
              </TooltipPrimitive.Trigger>
              <TooltipPrimitive.Portal>
                <TooltipPrimitive.Content
                  side="top"
                  sideOffset={TIP_OFFSET}
                  aria-label={name}
                  data-delivery-dock-tip=""
                  className="pointer-events-none z-50"
                >
                  <motion.span
                    initial={reduce ? { opacity: 0 } : TIP.initial}
                    animate={TIP.animate}
                    transition={reduce ? REDUCED_TRANSITION : TIP.transition}
                    className="block rounded-sm bg-peek px-2 py-1 text-xs leading-4 font-medium whitespace-nowrap text-peek-fg"
                  >
                    {name}
                  </motion.span>
                </TooltipPrimitive.Content>
              </TooltipPrimitive.Portal>
            </TooltipPrimitive.Root>
          </span>
          <PopoverContent
            ref={floating}
            side="top"
            align="start"
            sideOffset={DIAL_GAP}
            alignOffset={-DIAL_INSET}
            collisionPadding={8}
            // Not a dialog: the dial is the radio group it contains, and
            // the glyph's aria-controls names that group.
            role={undefined}
            data-delivery-dock-dial=""
            className={cn(
              DIAL_LAYER,
              "origin-(--radix-popover-content-transform-origin)",
              carried && "animate-none"
            )}
            onFocus={(event) => {
              focusInDial.current = {
                ring: event.target.matches(":focus-visible"),
              }
            }}
            onBlur={(event) => {
              const next = event.relatedTarget
              if (next && !event.currentTarget.contains(next))
                focusInDial.current = null
            }}
            onOpenAutoFocus={(event) => {
              event.preventDefault()
              takeFocus()
            }}
            // Focus goes where the close sends it (fold or the press).
            onCloseAutoFocus={(event) => event.preventDefault()}
            onEscapeKeyDown={() => {
              closedBy.current = "escape"
            }}
            // The glyph toggles the dial: its press must not close it first.
            onInteractOutside={(event) => {
              if (
                event.target instanceof Node &&
                trigger.current?.contains(event.target)
              )
                event.preventDefault()
            }}
            // In the DOM right after the glyph, so Tab runs through it in
            // the page's order.
            portal={false}
          >
            <motion.div
              initial={reduce || carried ? false : { scale: SCALE.collapse }}
              animate={{ scale: 1 }}
              transition={SPRING.responsive}
              style={{ transformOrigin: DIAL_ORIGIN }}
              // Tab leaves in the page's order (see DeliveryTitleDial).
              onKeyDown={(event) => {
                if (event.key === "Tab") event.stopPropagation()
              }}
            >
              <DeliveryDial
                size="popover"
                // Opened from the dock, it wears the dock (its ring is the
                // dock's inverse one).
                tone="dock"
                id={dialId}
                label={DIAL_LABEL}
                value={value}
                onChange={onChange}
                offered={offered}
                className="max-w-[calc(100vw-16px)]"
              />
            </motion.div>
          </PopoverContent>
        </Popover>
      </TooltipPrimitive.Provider>
    </span>
  )
}
