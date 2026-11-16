/* ─────────────────────────────────────────────────────────
 * ANIMATION STORYBOARD — Review delivery dial
 *
 *    0ms   thumb springs to the new stop (SPRING.snappy, slight
 *          overshoot that settles); labels never move
 *    0ms   label tone shifts (CSS, TIMING.surfaceTone)
 *
 * Rapid changes retarget the spring mid-flight; nothing queues.
 * Reduced motion: the thumb snaps. Tone shifts and focus rings stay.
 * Large at narrow widths (2×2): no travelling thumb; the checked stop
 * carries the thumb's surface itself.
 *
 * Ticks (the glyph), animated only after the title:
 *    0ms   a changing tick's fill grows from its base or shrinks into it,
 *          scaleY on SPRING.snappy, opacity over TIMING.hint (standard);
 *          `barDelay` apart, filling left to right, emptying right to
 *          left. A tick in motion reverses from where it is.
 * Reduced motion: no growth and no chain; the fill crossfades (150ms).
 * ───────────────────────────────────────────────────────── */

import * as React from "react"
import { motion, motionValue, useReducedMotionConfig } from "motion/react"
import type { MotionValue } from "motion/react"

import {
  CSS_TRANSITION,
  EASE,
  REDUCED_TRANSITION,
  SPRING,
  TIMING,
  ms,
} from "@workspace/ui/lib/motion"
import { cn } from "@workspace/ui/lib/utils"
import {
  DELIVERY_STOPS,
  DELIVERY_STOP_DESCRIPTION,
  DELIVERY_STOP_LABEL,
  deliveryStopIndex,
} from "@workspace/ui/neuve/shared/delivery"
import type { DeliveryStop } from "@workspace/ui/neuve/shared/delivery"

export type DeliveryDialSize = "compact" | "large" | "mini" | "popover"

export interface DeliveryDialProps {
  /**
   * compact: the desk toolbar; equal stops sized to the widest label.
   * large:   the settings hero, each stop with its description; 2×2 when
   *          its container is narrow.
   * mini:    a language row; equal stops sized to the widest label.
   * popover: opened from the title glyph; a card on the surface, equal
   *          stops, a raised thumb with a hairline ring.
   */
  size: DeliveryDialSize
  value: DeliveryStop
  onChange: (stop: DeliveryStop) => void
  /** Accessible group name, e.g. "Review delivery" or "Go delivery". */
  label: string
  /** Mini only: outline thumb and muted label while following the default. */
  follows?: boolean
  /** Id of text describing the group, e.g. a row's "Follows default". */
  describedBy?: string
  /** Id of the radio group, e.g. for the title glyph's aria-controls. */
  id?: string
  /**
   * Popover only: card, a floating card with the card shadow (default);
   * line, a 1px --line edge and no shadow, for a dial in the page's flow.
   */
  edge?: "card" | "line"
  /**
   * Popover only: page, the card surface (default); dock, the decision
   * dock's dark surface, for the dial opened from the dock's glyph (round
   * 7): the dock fill, a dock-hover thumb, dock-muted stops and dock-fg on
   * hover and the checked stop. Its shadow and its inverse focus ring come
   * from the dock it opens in (its drop-shadow filter and data-surface).
   */
  tone?: "page" | "dock"
  /**
   * The stops this unit offers (`offeredStops`); absent, all four. A stop
   * left out keeps its place and its ticks but is a disabled radio: arrow
   * keys skip it, a screen reader announces it unavailable, and it reads
   * muted with no hover.
   */
  offered?: ReadonlyArray<DeliveryStop>
  className?: string
}

const THUMB = {
  spring: SPRING.snappy,
  snap: { duration: 0 },
} as const

/** Thumb lift (--nv-shadow-thumb, light and dark). */
const THUMB_SURFACE = "bg-surface shadow-thumb"

/**
 * While a language follows the default: outline only, in --nv-muted, which
 * keeps 3:1 on the raised group (--line-strong measures 2.99 there in dark).
 */
const THUMB_OUTLINE = "bg-transparent shadow-[inset_0_0_0_1px_var(--nv-muted)]"

/** On a raised fill, empty ticks step to --nv-muted (see HOLLOW). */
export const TICKS_ON_RAISED = "[--tick-hollow:var(--nv-muted)]"

const FOCUS_RING =
  "has-[input:focus-visible]:outline-2 has-[input:focus-visible]:outline-offset-1 has-[input:focus-visible]:outline-focus"

/**
 * The popover dial on the dock (`tone="dock"`). No shadow of its own: it
 * sits inside the dock bar, whose drop-shadow filter (the dock's shadow)
 * draws around it too, so one shadow, the dock's.
 */
const DOCK_TONE = {
  surface: "bg-dock [--tick-hollow:var(--nv-dock-muted)]",
  thumbSurface: "bg-dock-hover shadow-[inset_0_0_0_1px_var(--nv-dock-line)]",
  on: "text-dock-fg font-medium [--tick-hollow:var(--nv-dock-muted)]",
  off: "text-dock-muted hover:text-dock-fg",
  /** Not offered: the dock's muted stop, dimmed as a disabled control. */
  unavailable: "cursor-default text-dock-muted opacity-50",
} as const

/** Not offered, on the page's surfaces: the faint tone, never pressable. */
const UNAVAILABLE = "cursor-default text-faint"

/** Reserves the medium (checked) width of a label with an invisible copy. */
const LABEL_RESERVE =
  "inline-grid after:invisible after:h-0 after:overflow-hidden after:font-medium after:content-[attr(data-text)]"

const SIZE = {
  compact: {
    // Equal stops, each as wide as the widest (fr tracks in a max-content
    // grid), 12px inline padding. Below sm the glyph hides and the padding
    // drops to 8px so it fits a 311px phone column; past that the tracks
    // shrink (minmax 0) rather than overflow.
    group: "grid-cols-[repeat(4,minmax(0,1fr))] rounded-[10px] p-[3px]",
    surface: cn("bg-raised", TICKS_ON_RAISED),
    thumb: "inset-y-[3px] left-[3px] w-[calc((100%-6px)/4)] rounded-lg",
    thumbSurface: THUMB_SURFACE,
    stop: "h-[34px] min-w-0 justify-center gap-1.5 rounded-lg px-3 text-[12.5px] whitespace-nowrap max-sm:px-2 pointer-coarse:h-11",
    glyph: "max-sm:hidden",
    on: "font-medium",
  },
  large: {
    group: "grid-cols-2 rounded-[14px] p-1 @min-[520px]/dial:grid-cols-4",
    surface: cn("bg-raised", TICKS_ON_RAISED),
    thumb:
      "inset-y-1 left-1 hidden w-[calc((100%-8px)/4)] rounded-[11px] @min-[520px]/dial:block",
    thumbSurface: THUMB_SURFACE,
    stop: "min-h-11 flex-col items-start gap-1.5 rounded-[11px] px-3.5 pt-3.5 pb-4",
    glyph: "",
    on: cn(
      THUMB_SURFACE,
      "@min-[520px]/dial:bg-transparent @min-[520px]/dial:shadow-none"
    ),
  },
  mini: {
    // Same equal-width rule as compact, on a smaller scale.
    group: "grid-cols-[repeat(4,minmax(0,1fr))] rounded-lg p-0.5",
    surface: cn("bg-raised", TICKS_ON_RAISED),
    thumb: "inset-y-0.5 left-0.5 w-[calc((100%-4px)/4)] rounded-md",
    thumbSurface: THUMB_SURFACE,
    stop: "h-[26px] min-w-0 justify-center rounded-md px-3 text-[11.5px] whitespace-nowrap max-sm:px-2 pointer-coarse:h-11",
    glyph: "",
    on: "font-medium",
  },
  popover: {
    // DialTitle.dc.html `.bdial`: the compact rule (equal stops, 9px
    // padding) on the card surface. Below sm the glyph hides and the
    // padding drops to 8px, so it fits a 343px phone column.
    // The card shadow, or a line in the flow: see `edge`.
    group: "grid-cols-[repeat(4,minmax(0,1fr))] rounded-[10px] p-[3px]",
    surface: "bg-surface",
    thumb: "inset-y-[3px] left-[3px] w-[calc((100%-6px)/4)] rounded-lg",
    // `.bthumb`: raised, with an inset hairline.
    thumbSurface: "bg-raised shadow-[inset_0_0_0_1px_var(--nv-line)]",
    stop: "h-[34px] min-w-0 justify-center gap-1.5 rounded-lg px-[9px] text-[12.5px] whitespace-nowrap max-sm:px-2 pointer-coarse:h-11",
    glyph: "max-sm:hidden",
    // The checked stop sits on the raised thumb (see HOLLOW).
    on: cn("font-medium", TICKS_ON_RAISED),
  },
} as const

/** Tick heights, short to tall, and their box (DialTitle.dc.html `.ticks`). */
const TICKS = {
  /** Inside a dial stop, beside its 12.5–16px label. */
  stop: { box: "h-2.5 gap-[1.5px]", bar: "w-[3px]", heights: [4, 6, 8, 10] },
  /** After the desk title: 4px wide, 5/8/11/14px tall. */
  title: { box: "h-3.5 gap-0.5", bar: "w-1", heights: [5, 8, 11, 14] },
} as const

export type DeliveryTicksSize = keyof typeof TICKS

/**
 * An empty tick is hollow: a 1px inset outline in --line-strong, which keeps
 * 3:1 on the page and the surface. On a raised fill (a dial's group, the
 * checked stop's thumb, the title glyph while hovered, focused or open) the
 * container sets --tick-hollow to --nv-muted, which keeps 3:1 there.
 */
const HOLLOW =
  "shadow-[inset_0_0_0_1px_var(--tick-hollow,var(--nv-line-strong))]"

/** The fill, grown from the tick's base. */
const FILL = "absolute inset-0 origin-bottom rounded-[1px] bg-current"

/**
 * The delivery glyph: four ascending ticks, filled solid up to `stop`, hollow
 * after it, so depth reads by shape as well as tone. More ticks, more
 * layers. Decorative; the stop name carries the meaning.
 *
 * `animated` (the title glyph) grows each fill from its base, scaleY and
 * opacity, when the stop changes; a static glyph (a dial stop) never moves.
 */
export function DeliveryTicks({
  stop,
  size = "stop",
  animated = false,
  barDelay = 0,
  className,
}: {
  stop: DeliveryStop
  size?: DeliveryTicksSize
  /** The fills follow changes of `stop`. */
  animated?: boolean
  /**
   * Animated only: milliseconds between one tick's start and the next's,
   * in the change's direction (filling left to right, emptying right to
   * left). 0 moves every changing tick at once.
   */
  barDelay?: number
  className?: string
}) {
  const level = deliveryStopIndex(stop)
  const look = TICKS[size]
  return (
    <span
      aria-hidden="true"
      data-delivery-ticks={size}
      className={cn("flex shrink-0 items-end", look.box, className)}
    >
      {animated ? (
        <AnimatedFills
          level={level}
          heights={look.heights}
          bar={look.bar}
          barDelay={barDelay}
        />
      ) : (
        look.heights.map((height, index) => (
          <i
            key={height}
            data-filled={index <= level || undefined}
            style={{ height }}
            className={cn("relative block rounded-[1px]", look.bar, HOLLOW)}
          >
            {index <= level && <b className={FILL} />}
          </i>
        ))
      )}
    </span>
  )
}

interface Fill {
  scale: MotionValue<number>
  opacity: MotionValue<number>
}

/**
 * One change's start order (DialTitle.dc.html `dtBarPlan`), read from what
 * is on screen now: a tick in motion reverses at once (0); a tick at rest
 * that has to change waits one step per changing tick before it, filling
 * left to right, emptying right to left; a tick that hasn't started and is
 * already where it should be stays.
 */
function startOrder(fills: ReadonlyArray<Fill>, want: ReadonlyArray<number>) {
  const now = fills.map(({ scale }) => {
    const value = scale.get()
    return {
      moving:
        Math.abs(scale.getVelocity()) > 0.01 ||
        (value > 0.001 && value < 0.999),
      shown: value > 0.5,
    }
  })
  const shown = now.filter((tick) => tick.shown).length
  const wanted = want.filter((on) => on === 1).length
  const order = wanted >= shown ? [0, 1, 2, 3] : [3, 2, 1, 0]
  const steps = [0, 0, 0, 0]
  let n = 0
  for (const tick of order) {
    if (now[tick]!.moving) n++
    else if (now[tick]!.shown !== (want[tick] === 1)) steps[tick] = n++
  }
  return steps
}

function AnimatedFills({
  level,
  heights,
  bar,
  barDelay,
}: {
  level: number
  heights: ReadonlyArray<number>
  bar: string
  barDelay: number
}) {
  const reduce = useReducedMotionConfig()
  // The fills' values, made once at the first stop: later stops animate
  // them, and the start order reads them to retarget from what is on screen.
  const fills = React.useMemo<Array<Fill>>(
    () =>
      heights.map((_, index) => {
        const on = index <= level ? 1 : 0
        return { scale: motionValue(on), opacity: motionValue(on) }
      }),
    []
  )
  const want = heights.map((_, index) => (index <= level ? 1 : 0))
  const steps =
    reduce || barDelay === 0 ? [0, 0, 0, 0] : startOrder(fills, want)
  return heights.map((height, index) => {
    const on = want[index]!
    const delay = ms(steps[index]! * barDelay)
    return (
      <i
        key={height}
        data-filled={on === 1 || undefined}
        style={{ height }}
        className={cn("relative block rounded-[1px]", bar, HOLLOW)}
      >
        <motion.b
          className={FILL}
          initial={false}
          style={{
            scaleY: fills[index]!.scale,
            opacity: fills[index]!.opacity,
          }}
          // Reduced motion: no growth and no chain; the fill crossfades.
          animate={
            reduce ? { scaleY: 1, opacity: on } : { scaleY: on, opacity: on }
          }
          transition={
            reduce
              ? { scaleY: { duration: 0 }, opacity: REDUCED_TRANSITION }
              : {
                  scaleY: { ...SPRING.snappy, delay },
                  opacity: {
                    duration: ms(TIMING.hint),
                    ease: EASE.standard,
                    delay,
                  },
                }
          }
        />
      </i>
    )
  })
}

/**
 * Review delivery dial: four detents, never a continuous slider.
 *
 * A native radio group (visually hidden inputs over styled labels), so arrow
 * keys move between stops and a screen reader announces "Review delivery,
 * Briefed, 2 of 4". Only the thumb travels. No readout and no caption: the
 * dial stands alone. A stop the unit doesn't offer keeps its place as a
 * native disabled radio, which the browser's arrow keys skip.
 */
export function DeliveryDial({
  size,
  value,
  onChange,
  label,
  follows = false,
  describedBy,
  id,
  edge = "card",
  tone = "page",
  offered = DELIVERY_STOPS,
  className,
}: DeliveryDialProps) {
  const name = React.useId()
  const reduce = useReducedMotionConfig()
  const index = deliveryStopIndex(value)
  const look = SIZE[size]
  const outlined = size === "mini" && follows
  const dock = size === "popover" && tone === "dock"
  return (
    <div
      className={cn(
        size === "large" ? "@container/dial w-full" : "w-max max-w-full",
        className
      )}
    >
      <div
        id={id}
        role="radiogroup"
        aria-label={label}
        aria-describedby={describedBy}
        data-size={size}
        data-follows={outlined || undefined}
        className={cn(
          "relative grid",
          dock ? DOCK_TONE.surface : look.surface,
          look.group,
          size === "popover" &&
            !dock &&
            (edge === "line"
              ? "shadow-[inset_0_0_0_1px_var(--nv-line)]"
              : "shadow-card")
        )}
      >
        <motion.span
          aria-hidden="true"
          data-dial-thumb=""
          initial={false}
          animate={{ x: `${index * 100}%` }}
          transition={reduce ? THUMB.snap : THUMB.spring}
          className={cn(
            "pointer-events-none absolute",
            look.thumb,
            outlined
              ? THUMB_OUTLINE
              : dock
                ? DOCK_TONE.thumbSurface
                : look.thumbSurface
          )}
        />
        {DELIVERY_STOPS.map((stop) => {
          const on = stop === value
          const unavailable = !on && !offered.includes(stop)
          const nameId = `${name}-${stop}-name`
          const descriptionId = `${name}-${stop}-description`
          return (
            <label
              key={stop}
              data-unavailable={unavailable || undefined}
              className={cn(
                "relative z-1 flex items-center",
                !unavailable && "cursor-pointer",
                CSS_TRANSITION.tone,
                FOCUS_RING,
                look.stop,
                dock
                  ? on
                    ? DOCK_TONE.on
                    : unavailable
                      ? DOCK_TONE.unavailable
                      : DOCK_TONE.off
                  : on
                    ? outlined
                      ? "text-ink-muted"
                      : cn("text-ink", look.on)
                    : unavailable
                      ? UNAVAILABLE
                      : "text-ink-muted hover:text-ink-2"
              )}
            >
              <input
                type="radio"
                name={name}
                value={stop}
                checked={on}
                disabled={unavailable}
                onChange={() => onChange(stop)}
                aria-labelledby={nameId}
                aria-describedby={size === "large" ? descriptionId : undefined}
                className={cn(
                  "absolute inset-0 m-0 appearance-none opacity-0",
                  unavailable ? "cursor-default" : "cursor-pointer"
                )}
              />
              {size === "large" ? (
                <>
                  <span
                    id={nameId}
                    className="flex items-center gap-2 text-base font-semibold tracking-[-0.01em]"
                  >
                    <DeliveryTicks stop={stop} />
                    {DELIVERY_STOP_LABEL[stop]}
                  </span>
                  <span
                    id={descriptionId}
                    className="text-[12.5px] leading-[17px] text-ink-muted"
                  >
                    {DELIVERY_STOP_DESCRIPTION[stop]}
                  </span>
                </>
              ) : (
                <>
                  {size !== "mini" && (
                    <DeliveryTicks stop={stop} className={look.glyph} />
                  )}
                  {/* The hidden medium-weight copy reserves the checked
                      width, so checking a stop never resizes the dial. */}
                  <span
                    id={nameId}
                    data-text={DELIVERY_STOP_LABEL[stop]}
                    className={LABEL_RESERVE}
                  >
                    {DELIVERY_STOP_LABEL[stop]}
                  </span>
                </>
              )}
            </label>
          )
        })}
      </div>
    </div>
  )
}
