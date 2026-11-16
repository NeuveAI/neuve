/* ─────────────────────────────────────────────────────────
 * ANIMATION STORYBOARD — Delivery dial in the title (DialTitle.dc.html, B)
 *
 * Four ticks after the desk title show the stop; pressing them opens the
 * dial. With room after the glyph it floats beside the title; without, it
 * opens in flow below the title row and pushes what follows down, so it
 * never covers the briefing while it stays open.
 *
 *  hover   the glyph takes the raised fill and ink 2 (TIMING.surfaceTone);
 *          the name fades in above it, rising OFFSET.hint (TIMING.hint,
 *          iOS ease-out). Hidden while the dial is open. A popup trigger:
 *          no press compress.
 *  change  the thumb springs (SPRING.snappy); the ticks follow at once,
 *          filling left to right or emptying right to left (`barDelay`
 *          apart; 0 until the chain is approved)
 *
 * Beside (floating, the shadcn Popover):
 *  open    the dial grows from the glyph: scale SCALE.collapse → 1 around
 *          the glyph's centre on SPRING.responsive, opacity 0 → 1 over
 *          TIMING.card (standard decelerate)
 *  fold    scale → SCALE.collapse and opacity → 0 over TIMING.cardExit
 *          (emphasized accelerate)
 *
 * Inline (in flow, narrow):
 *  open    0ms  the dial enters the flow; what follows slides from where
 *               it was to its new place (FLIP, transform only): one
 *               monotonic movement, TIMING.card, EASE.standard
 *          t75  at 75% of that movement the dial's contents fade in
 *               (TIMING.hint, standard decelerate)
 *  close   the reverse: the contents fade out (TIMING.hint, emphasized
 *          accelerate) and are out by 25% of the movement; what follows
 *          slides back up over TIMING.card; then the dial leaves the flow
 *
 * Either placement folds on the glyph, Escape, a press outside it or focus
 * moving outside it; choosing a stop never folds it.
 * Reduced motion: beside, the dial fades in and out (150ms), no scale.
 * Inline, the flow snaps, then the contents fade (150ms); closing, they
 * fade, then the flow snaps. The thumb jumps; the ticks crossfade.
 * ───────────────────────────────────────────────────────── */

import * as React from "react"
import { atom, useAtom, useStore } from "jotai"
import {
  AnimatePresence,
  motion,
  usePresence,
  useReducedMotionConfig,
} from "motion/react"
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
  SPRING,
  TIMING,
  cssBezier,
} from "@workspace/ui/lib/motion"
import { cn } from "@workspace/ui/lib/utils"
import { DELIVERY_STOP_LABEL } from "@workspace/ui/neuve/shared/delivery"
import type { DeliveryStop } from "@workspace/ui/neuve/shared/delivery"
import {
  DeliveryDial,
  DeliveryTicks,
} from "@workspace/ui/neuve/shared/delivery-dial"
import {
  DIAL_LABEL,
  DIAL_LAYER,
  TIP,
  TIP_OFFSET,
  focusGlyphQuietly,
  focusedQuietly,
} from "@workspace/ui/neuve/review-desk/delivery/delivery-glyph-shared"

/** Gap between the glyph and the dial (px). */
const DIAL_OFFSET = 8
/** Space kept between the dial and its boundary's edge (px). */
const DIAL_PADDING = 8

/**
 * measure: opening, the dial's width not known yet (laid out unseen, out
 * of flow, for one commit); beside: floating after the glyph; inline: in
 * flow below the title row.
 */
type DialPlace = "measure" | "beside" | "inline"

/**
 * Beside: the card's fade in and its fold run in CSS on the popover's own
 * open and closed states (DIAL_LAYER); the growth from the glyph is a
 * spring on the dial inside it.
 */
const BESIDE = cn(
  DIAL_LAYER,
  // Grows from and folds toward the glyph's centre (8px gap + 16px).
  "origin-[-24px_50%]"
)

/**
 * The share of a cubic-bezier's duration at which it has covered `travel`
 * (0–1) of its distance. EASE.standard rises monotonically, so this is
 * well defined.
 */
function timeAt(curve: ReadonlyArray<number>, travel: number) {
  const [x1, y1, x2, y2] = curve as [number, number, number, number]
  const at = (a: number, b: number, s: number) =>
    3 * (1 - s) ** 2 * s * a + 3 * (1 - s) * s ** 2 * b + s ** 3
  let low = 0
  let high = 1
  for (let step = 0; step < 30; step++) {
    const mid = (low + high) / 2
    if (at(y1, y2, mid) < travel) low = mid
    else high = mid
  }
  return at(x1, x2, (low + high) / 2)
}

/** The inline movement and its content beats (ms). */
const FLOW = {
  duration: TIMING.card,
  easing: cssBezier(EASE.standard),
  /** Contents start fading in at 75% of the movement's travel. */
  contentIn: Math.round(timeAt(EASE.standard, 0.75) * TIMING.card),
  /** Closing, the contents are out by 25% of the movement's travel. */
  moveOut: Math.max(
    0,
    TIMING.hint - Math.round(timeAt(EASE.standard, 0.25) * TIMING.card)
  ),
}

/* ─── What follows the title: FLIP, transform only ────────────────────── */

/**
 * The region whose content the inline dial pushes: the caller's `flow`
 * (the desk passes its scroll column), or else the title's nearest
 * scrolling ancestor, or else the body.
 */
function regionOf(root: HTMLElement | null, flow: HTMLElement | null) {
  if (flow) return flow
  for (let up = root?.parentElement ?? null; up; up = up.parentElement) {
    if (up === document.body) break
    const { overflowY } = getComputedStyle(up)
    if (overflowY === "auto" || overflowY === "scroll") return up
  }
  return document.body
}

/**
 * Everything laid out after the title line inside `region`: each
 * ancestor's later siblings, from the title line up to the region (its own
 * siblings are outside it and left alone). Out-of-flow boxes don't move
 * with the flow and are skipped.
 */
function followersOf(
  root: HTMLElement | null,
  region: HTMLElement
): Array<HTMLElement> {
  const out: Array<HTMLElement> = []
  let level = root?.parentElement ?? null
  while (level && level !== region && region.contains(level)) {
    for (
      let next = level.nextElementSibling;
      next;
      next = next.nextElementSibling
    ) {
      if (!(next instanceof HTMLElement)) continue
      const { position, display } = getComputedStyle(next)
      if (position === "absolute" || position === "fixed") continue
      if (display === "none") continue
      out.push(next)
    }
    level = level.parentElement
  }
  return out
}

/** Visual tops (transforms included: a slide in flight). */
const topsOf = (elements: Array<HTMLElement>) =>
  elements.map((element) => element.getBoundingClientRect().top)

/** Moves of less than this (px) are no move: rounding, not the flow. */
const STILL = 0.5

/**
 * Slides each element from its visual top in `from` to `to[i]` px from its
 * place in the layout now. A box that neither is displaced now nor has to
 * go anywhere (a sticky dock, a column beside) is left alone. Added to
 * whatever transform it already has (composite "add"), so motion's own
 * transforms on it are untouched.
 */
function slide(
  elements: Array<HTMLElement>,
  from: Array<number>,
  to: Array<number>,
  options: { delay?: number; hold?: boolean }
): Array<Animation> {
  return elements.flatMap((element, index) => {
    const offset = from[index]! - element.getBoundingClientRect().top
    const end = to[index]!
    if (Math.abs(offset) < STILL && Math.abs(end) < STILL) return []
    return [
      element.animate(
        [
          { transform: `translateY(${offset}px)` },
          { transform: `translateY(${end}px)` },
        ],
        {
          duration: FLOW.duration,
          easing: FLOW.easing,
          delay: options.delay ?? 0,
          fill: options.hold ? "both" : "backwards",
          composite: "add",
        }
      ),
    ]
  })
}

/* ─── The glyph ───────────────────────────────────────────────────────── */

/**
 * A popup trigger, so no press compress (globals.css `press`): the dial is
 * anchored to it, and a compress would shift a floating dial.
 */
const TRIGGER = cn(
  "relative inline-flex size-8 items-center justify-center rounded-sm text-ink-muted",
  "transition-colors duration-surface-tone ease-standard motion-reduce:transition-none",
  // 44px hit area around the 32px glyph.
  "after:absolute after:top-1/2 after:left-1/2 after:size-11 after:-translate-1/2",
  // One tone step on hover and keyboard focus; the empty ticks step to
  // --nv-muted there to keep 3:1 on the raised fill (written out:
  // TICKS_ON_RAISED with each variant, so Tailwind sees the classes).
  "not-aria-expanded:hover:bg-raised not-aria-expanded:hover:text-ink-2 not-aria-expanded:focus-visible:bg-raised not-aria-expanded:focus-visible:text-ink-2",
  "not-aria-expanded:hover:[--tick-hollow:var(--nv-muted)] not-aria-expanded:focus-visible:[--tick-hollow:var(--nv-muted)]",
  // Open, a step further, so it never reads as rest or hover (round 7):
  // raised-2 with a 1px line edge, ink ticks, hollow ticks outlined in
  // ink-2 (3:1 or better on raised-2).
  "aria-expanded:bg-raised-2 aria-expanded:text-ink aria-expanded:shadow-[inset_0_0_0_1px_var(--nv-line)] aria-expanded:[--tick-hollow:var(--nv-ink-2)]",
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
)

export interface DeliveryTitleDialProps {
  value: DeliveryStop
  onChange: (stop: DeliveryStop) => void
  /** The stops the unit offers; the rest are disabled (DeliveryDial). */
  offered?: ReadonlyArray<DeliveryStop>
  /**
   * Milliseconds between one tick's start and the next's when the stop
   * changes (default 0: every changing tick moves at once).
   */
  barDelay?: number
  /**
   * The dial floats beside the glyph only if it fits inside this element
   * (default: `flow`, else the viewport); otherwise it opens in flow below
   * the title row. Read when the dial opens and on resize.
   */
  boundary?: React.RefObject<HTMLElement | null>
  /**
   * The region whose content the inline dial pushes down and slides (the
   * desk: its scroll column, `[data-desk-scroll]`). Nothing outside it is
   * measured or moved. Default: the title's nearest scrolling ancestor, or
   * the body.
   */
  flow?: React.RefObject<HTMLElement | null>
  /**
   * Round 7: called when the glyph goes out of view and when it comes back
   * (it is observed against the viewport, so the desk's scroll column and
   * the page both clip it). Going out, an open dial closes; when focus was
   * in it, `focus` says so (and whether it showed the ring), so the caller
   * can hand focus to the dock's glyph. Pass a stable function.
   */
  onAway?: (away: boolean, focus: { ring: boolean } | null) => void
  className?: string
}

/**
 * Review delivery in the title: a 32px glyph after the desk's h1 that
 * opens the delivery dial. Place it inside the title's line (a block that
 * holds the h1 inline): the inline dial is a block in that line, below
 * the h1 and the glyph.
 *
 * It dismisses like any other layer: a press outside it, Escape, or focus
 * moving outside it closes it, and the glyph toggles it. Choosing a stop
 * never closes it. Escape and the glyph return focus to the glyph; after
 * an outside press, focus stays where the press put it. Non-modal: no
 * focus trap.
 */
export function DeliveryTitleDial({
  value,
  onChange,
  offered,
  barDelay = 0,
  boundary,
  flow,
  onAway,
  className,
}: DeliveryTitleDialProps) {
  const openAtom = React.useMemo(() => atom(false), [])
  const tipAtom = React.useMemo(() => atom(false), [])
  const placeAtom = React.useMemo(() => atom<DialPlace>("measure"), [])
  const [open, setOpen] = useAtom(openAtom)
  const [tip, setTip] = useAtom(tipAtom)
  const [place, setPlace] = useAtom(placeAtom)
  const store = useStore()
  const reduce = useReducedMotionConfig() ?? false
  const dialId = React.useId()
  const root = React.useRef<HTMLDivElement | null>(null)
  const trigger = React.useRef<HTMLButtonElement | null>(null)
  const floating = React.useRef<HTMLDivElement | null>(null)
  const inline = React.useRef<HTMLDivElement | null>(null)
  // How the dial was opened: from the keyboard, the checked stop shows its
  // focus ring; from a pointer it takes focus without one.
  const byKeyboard = React.useRef(false)
  // The next dial to mount takes focus (on open, or when a resize moves a
  // focused dial between placements).
  const wantsFocus = React.useRef(false)
  // What followed the title, and where, just before the inline dial
  // entered the flow.
  const before = React.useRef<{
    followers: Array<HTMLElement>
    tops: Array<number>
  } | null>(null)
  // Why the floating dial is closing: Escape returns focus to the glyph;
  // a press or focus elsewhere leaves it where it went.
  const closedBy = React.useRef<"escape" | null>(null)

  const name = `${DIAL_LABEL}: ${DELIVERY_STOP_LABEL[value]}`

  const takeFocus = (container: HTMLElement | null) => {
    if (!wantsFocus.current || !container) return
    wantsFocus.current = false
    container
      .querySelector<HTMLInputElement>("input:checked")
      ?.focus({ focusVisible: byKeyboard.current, preventScroll: true })
  }

  /**
   * Beside when the dial (width `width`) fits between the glyph and the
   * boundary's end; otherwise inline. Entering the flow, what follows is
   * recorded first, so it can slide from there.
   */
  const choose = React.useCallback(
    (width: number) => {
      const anchor = trigger.current
      if (!anchor) return
      const end =
        (boundary?.current ?? flow?.current)?.getBoundingClientRect().right ??
        document.documentElement.clientWidth
      const need = anchor.getBoundingClientRect().right + DIAL_OFFSET + width
      const next: DialPlace = need > end - DIAL_PADDING ? "inline" : "beside"
      if (next === "inline") {
        const followers = followersOf(
          root.current,
          regionOf(root.current, flow?.current ?? null)
        )
        before.current = { followers, tops: topsOf(followers) }
      }
      setPlace(next)
    },
    [boundary, flow, setPlace]
  )

  // A resize moves an open dial between placements when the room changes.
  // Effect: subscribes to window resizes (an external system) while open.
  React.useEffect(() => {
    if (!open) return
    const onResize = () => {
      const shown = place === "inline" ? inline.current : floating.current
      const group = shown?.querySelector<HTMLElement>('[role="radiogroup"]')
      if (!shown || !group) return
      if (shown.contains(document.activeElement)) wantsFocus.current = true
      choose(group.offsetWidth)
    }
    window.addEventListener("resize", onResize)
    return () => window.removeEventListener("resize", onResize)
  }, [open, place, choose])

  // Focus was last in the floating dial, and whether it showed its ring. A
  // stop hidden with the dial (hideWhenDetached) drops focus to the body;
  // this remembers where it was.
  const focusInDial = React.useRef<{ ring: boolean } | null>(null)

  // The glyph scrolls fully out of its column (PageDown from a stop, say):
  // the floating dial hides with it, so if focus was in the dial it closes
  // and focus comes back to the glyph, quietly, instead of to the body.
  // Effect: observes the glyph against its column (IntersectionObserver, an external system) while the floating dial is open.
  React.useEffect(() => {
    const glyph = trigger.current
    // With onAway, the observer below closes the dial instead.
    if (!open || place !== "beside" || !glyph || onAway) return
    const region = regionOf(root.current, flow?.current ?? null)
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry || entry.isIntersecting) return
        const active = document.activeElement
        const inDial = floating.current?.contains(active) ?? false
        const dropped =
          (active === null || active === document.body) &&
          focusInDial.current !== null
        if (!inDial && !dropped) return
        const ring =
          (inDial && active?.matches(":focus-visible")) ||
          (focusInDial.current?.ring ?? false)
        focusInDial.current = null
        setOpen(false)
        setTip(false)
        focusGlyphQuietly(glyph, ring)
      },
      { root: region === document.body ? null : region, threshold: 0 }
    )
    observer.observe(glyph)
    return () => observer.disconnect()
  }, [open, place, flow, onAway, setOpen, setTip])

  // Round 7: the glyph out of view (scrolled out of the desk's column, or of
  // the page: the viewport root sees both clips) moves the delivery glyph to
  // the dock. Going out closes an open dial, in either placement; focus that
  // was in it lands on this glyph for now, quietly, and the caller hands it
  // on to the dock's glyph.
  // Effect: observes the glyph against the viewport (IntersectionObserver, an external system) and reports it to the desk.
  React.useEffect(() => {
    const glyph = trigger.current
    if (!glyph || !onAway) return
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry) return
      const away = !entry.isIntersecting
      let focus: { ring: boolean } | null = null
      if (away && store.get(openAtom)) {
        const active = document.activeElement
        const inDial = [floating.current, inline.current].some(
          (dial) => dial?.contains(active) ?? false
        )
        const dropped =
          (active === null || active === document.body) &&
          focusInDial.current !== null
        const ring =
          (inDial && (active?.matches(":focus-visible") ?? false)) ||
          (focusInDial.current?.ring ?? false)
        focusInDial.current = null
        store.set(openAtom, false)
        store.set(tipAtom, false)
        if (inDial || dropped) {
          focus = { ring }
          focusGlyphQuietly(glyph, ring)
        }
      }
      onAway(away, focus)
    })
    observer.observe(glyph)
    return () => {
      observer.disconnect()
      onAway(false, null)
    }
  }, [onAway, store, openAtom, tipAtom])

  const fold = (keyboard: boolean) => {
    const inDial = [floating.current, inline.current].some(
      (dial) => dial?.contains(document.activeElement) ?? false
    )
    setOpen(false)
    setTip(false)
    // Escape, or a press on the glyph while focus is in the dial (Safari
    // doesn't focus a pressed button): focus comes back to the glyph.
    const glyph = trigger.current
    if (!glyph || (!keyboard && !inDial)) return
    focusGlyphQuietly(glyph, keyboard)
  }

  const onEscape = (event: React.KeyboardEvent) => {
    if (event.key !== "Escape" || !open) return
    event.preventDefault()
    event.stopPropagation()
    fold(true)
  }

  /** A press or focus outside: closed, and focus stays where it went. */
  const dismiss = () => {
    setOpen(false)
    setTip(false)
  }

  // The inline dial dismisses as the floating one does (and as the desk's
  // expanded layer does, OutsidePressDismiss in review-desk-screen.tsx): a
  // mouse press outside closes it on press, touch and pen on the tap, so a
  // scroll gesture leaves it open; focus moving outside closes it too. The
  // press goes on to what is underneath, which takes focus as usual.
  // Effect: listens to presses and focus on the document (an external event source) while the inline dial is open.
  React.useEffect(() => {
    if (!open || place !== "inline") return
    const inside = (event: Event) =>
      event
        .composedPath()
        .some((node) => node === inline.current || node === trigger.current)
    let pressedWith = "mouse"
    const onPointerDown = (event: PointerEvent) => {
      pressedWith = event.pointerType
      if (event.button !== 0 || inside(event)) return
      if (event.pointerType === "touch" || event.pointerType === "pen") return
      dismiss()
    }
    const onTap = (event: MouseEvent) => {
      const own = (event as Partial<PointerEvent>).pointerType
      const type = own === "touch" || own === "pen" ? own : pressedWith
      if (type !== "touch" && type !== "pen") return
      if (!inside(event)) dismiss()
    }
    const onFocusIn = (event: FocusEvent) => {
      if (!inside(event)) dismiss()
    }
    window.addEventListener("pointerdown", onPointerDown, true)
    window.addEventListener("click", onTap, true)
    document.addEventListener("focusin", onFocusIn, true)
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true)
      window.removeEventListener("click", onTap, true)
      document.removeEventListener("focusin", onFocusIn, true)
    }
  }, [open, place])

  const dial = (width: string, edge: "card" | "line" = "card") => (
    <DeliveryDial
      size="popover"
      edge={edge}
      id={dialId}
      label={DIAL_LABEL}
      value={value}
      onChange={onChange}
      offered={offered}
      className={width}
    />
  )

  return (
    <TooltipPrimitive.Provider delayDuration={0}>
      <Popover
        open={open && place === "beside"}
        onOpenChange={(next) => {
          if (next) return
          // A resize moved the open dial inline: the floating layer, still
          // leaving, takes the inline dial's focus for focus outside it.
          // The dial stays open.
          if (store.get(placeAtom) !== "beside") return
          // Radix closes it: Escape, or a press or focus outside it.
          if (closedBy.current === "escape") fold(true)
          else dismiss()
          closedBy.current = null
        }}
      >
        {/* Contents: the glyph sits in the title's line, and the inline
        dial is a block of that line, below the h1. */}
        <div ref={root} data-delivery-title-dial="" className="contents">
          {/* The glyph's box is the floating dial's containing block
          (will-change: transform): the dial is placed against it, so it
          moves with the title through any transform on the title's
          ancestors (the desk's stack morph) on the same frame, with nothing
          to re-measure, and doesn't jump when such a transform comes or
          goes. Not layout containment: that drops the box's baseline and
          lifts the glyph off the title's line. */}
          <div
            className={cn(
              "relative inline-flex align-[4px] will-change-transform",
              className
            )}
          >
            <TooltipPrimitive.Root
              open={tip && !open}
              onOpenChange={(next) => {
                // Not while the dial is open (a hover then would show the
                // name once it folds), and not for focus restored by script
                // after Escape.
                if (next && (open || focusedQuietly(trigger.current))) return
                setTip(next)
              }}
            >
              <TooltipPrimitive.Trigger asChild>
                <PopoverAnchor asChild>
                  <button
                    ref={trigger}
                    type="button"
                    data-delivery-trigger=""
                    aria-label={name}
                    aria-expanded={open}
                    aria-controls={dialId}
                    // The tooltip says the name; as a description it would
                    // be read twice. The button's own prop wins (Radix Slot).
                    aria-describedby={undefined}
                    className={TRIGGER}
                    onClick={(event) => {
                      if (open) return fold(event.detail === 0)
                      // Enter or Space click with detail 0.
                      byKeyboard.current = event.detail === 0
                      wantsFocus.current = true
                      setPlace("measure")
                      setTip(false)
                      focusInDial.current = null
                      setOpen(true)
                    }}
                    // Inline only: the floating dial is a Radix layer, and
                    // Radix hands Escape to the topmost layer.
                    onKeyDown={place === "inline" ? onEscape : undefined}
                  >
                    <DeliveryTicks
                      stop={value}
                      size="title"
                      animated
                      barDelay={barDelay}
                    />
                  </button>
                </PopoverAnchor>
              </TooltipPrimitive.Trigger>
              <TooltipPrimitive.Portal>
                <TooltipPrimitive.Content
                  side="top"
                  sideOffset={TIP_OFFSET}
                  aria-label={name}
                  data-delivery-title-tip=""
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
            {open && place === "measure" && (
              // Laid out unseen and out of flow for one commit: its width
              // picks the placement before anything paints.
              <div
                aria-hidden="true"
                inert
                className="invisible absolute top-0 left-0"
                ref={(node) => {
                  const group = node?.querySelector<HTMLElement>(
                    '[role="radiogroup"]'
                  )
                  if (group) choose(group.offsetWidth)
                }}
              >
                <DeliveryDial
                  size="popover"
                  label={DIAL_LABEL}
                  value={value}
                  onChange={onChange}
                  offered={offered}
                  className="max-w-[calc(100vw-16px)]"
                />
              </div>
            )}
            <PopoverContent
              ref={floating}
              side="right"
              align="center"
              sideOffset={DIAL_OFFSET}
              avoidCollisions={false}
              // Not a dialog: the dial is the radio group it contains, and
              // the glyph's aria-controls names that group.
              role={undefined}
              data-delivery-dial-place="beside"
              className={BESIDE}
              onFocus={(event) => {
                focusInDial.current = {
                  ring: event.target.matches(":focus-visible"),
                }
              }}
              onBlur={(event) => {
                // Focus went somewhere real outside the dial. A drop to the
                // body (no relatedTarget) keeps the record: the dial hid.
                const next = event.relatedTarget
                if (next && !event.currentTarget.contains(next))
                  focusInDial.current = null
              }}
              onOpenAutoFocus={(event) => {
                event.preventDefault()
                takeFocus(floating.current)
              }}
              // Focus goes where the close sends it (fold or the press).
              onCloseAutoFocus={(event) => event.preventDefault()}
              onEscapeKeyDown={() => {
                closedBy.current = "escape"
              }}
              // The glyph is outside the card but toggles it: its press (and
              // the focus it takes) must not close the card first, or the
              // click would open it again.
              onInteractOutside={(event) => {
                if (
                  event.target instanceof Node &&
                  trigger.current?.contains(event.target)
                )
                  event.preventDefault()
              }}
              // In the DOM right after the glyph (not portaled), so Tab runs
              // through it in the page's own order.
              portal={false}
              // Hidden while the glyph is scrolled out of its column, so the
              // fixed dial never floats over what is above the column.
              hideWhenDetached
            >
              <motion.div
                initial={reduce ? false : { scale: SCALE.collapse }}
                animate={{ scale: 1 }}
                transition={SPRING.responsive}
                className="origin-[-24px_50%]"
                // Radix's focus scope listens for Tab on the content element
                // and loops it from the last stop to the first (and back).
                // Stopping Tab here, inside the content, keeps it from the
                // scope; the browser then moves focus in the page's order.
                onKeyDown={(event) => {
                  if (event.key === "Tab") event.stopPropagation()
                }}
              >
                {dial("max-w-[calc(100vw-16px)]")}
              </motion.div>
            </PopoverContent>
          </div>
          <AnimatePresence>
            {open && place === "inline" && (
              <InlineDial
                key="inline"
                ref={inline}
                reduce={reduce}
                followers={() =>
                  followersOf(
                    root.current,
                    regionOf(root.current, flow?.current ?? null)
                  )
                }
                takeBefore={() => {
                  const recorded = before.current
                  before.current = null
                  return recorded
                }}
                onShown={() => takeFocus(inline.current)}
                onKeyDown={onEscape}
              >
                {dial("max-w-full", "line")}
              </InlineDial>
            )}
          </AnimatePresence>
        </div>
      </Popover>
    </TooltipPrimitive.Provider>
  )
}

/**
 * The dial in flow, below the title row. It steps into the flow at once
 * and what follows slides down from where it was (FLIP); its contents fade
 * in at 75% of that movement. Leaving, the reverse, and it stays in the
 * flow until what follows has slid back up.
 */
function InlineDial({
  ref,
  reduce,
  followers,
  takeBefore,
  onShown,
  onKeyDown,
  children,
}: {
  ref: React.RefObject<HTMLDivElement | null>
  reduce: boolean
  followers: () => Array<HTMLElement>
  /** What followed, and where, before the dial entered the flow. */
  takeBefore: () => {
    followers: Array<HTMLElement>
    tops: Array<number>
  } | null
  onShown: () => void
  onKeyDown: (event: React.KeyboardEvent) => void
  children: React.ReactNode
}) {
  const [isPresent, safeToRemove] = usePresence()
  const content = React.useRef<HTMLDivElement | null>(null)
  const slides = React.useRef<Array<Animation>>([])
  const fade = React.useRef<Animation | null>(null)

  const stop = () => {
    for (const run of slides.current) run.cancel()
    slides.current = []
    fade.current?.cancel()
    fade.current = null
  }

  /**
   * The contents' fade, on the same clock as the slides (Web Animations),
   * from the opacity they show now.
   */
  const fadeTo = (
    element: HTMLElement,
    from: number,
    to: number,
    timing: { duration: number; easing: string; delay?: number }
  ) => {
    fade.current = element.animate([{ opacity: from }, { opacity: to }], {
      ...timing,
      fill: "both",
    })
    return fade.current
  }

  const whenDone = (run: Animation, done: () => void) =>
    void run.finished.then(
      () => {
        if (fade.current === run || slides.current.includes(run)) done()
      },
      // Cancelled: the dial came back before it left.
      () => {}
    )

  // Effect: runs the FLIP of what follows and the contents' fade (layout measured right after the dial enters or leaves the flow; Web Animations, an external system).
  React.useLayoutEffect(() => {
    const block = ref.current
    const inner = content.current
    if (!block || !inner) return
    const shown = Number(getComputedStyle(inner).opacity)
    const reducedFade = {
      duration: TIMING.reduced,
      easing: cssBezier(EASE.out),
    }
    if (isPresent) {
      // Arriving (from the tops recorded before), or coming back mid-close
      // (from where everything is now).
      const recorded = takeBefore()
      const below = recorded?.followers ?? followers()
      const from = recorded?.tops ?? topsOf(below)
      stop()
      onShown()
      if (reduce) {
        fadeTo(inner, shown, 1, reducedFade)
        return
      }
      slides.current = slide(
        below,
        from,
        below.map(() => 0),
        {}
      )
      fadeTo(inner, shown, 1, {
        duration: TIMING.hint,
        easing: cssBezier(EASE.standardDecelerate),
        delay: shown > 0 ? 0 : FLOW.contentIn,
      })
      return
    }
    // Leaving: each box that follows slides to where it will be once the
    // dial is out of the flow, measured now with the dial taken out and put
    // back (no paint between), and is held there until the dial leaves the
    // flow in the same commit. A sticky dock or a column beside doesn't
    // move, so it isn't slid.
    const below = followers()
    const from = topsOf(below)
    stop()
    if (reduce) {
      whenDone(fadeTo(inner, shown, 0, reducedFade), safeToRemove)
      return
    }
    const now = topsOf(below)
    const display = block.style.display
    block.style.display = "none"
    const after = topsOf(below)
    block.style.display = display
    const to = after.map((top, index) => top - now[index]!)
    const out = fadeTo(inner, shown, 0, {
      duration: TIMING.hint,
      easing: cssBezier(EASE.emphasizedAccelerate),
    })
    slides.current = slide(below, from, to, {
      delay: FLOW.moveOut,
      hold: true,
    })
    whenDone(slides.current.at(-1) ?? out, safeToRemove)
  }, [isPresent])

  // Effect: the held slides end in the commit that takes the dial out of the flow (Web Animations, an external system), so nothing jumps between them.
  React.useLayoutEffect(() => () => stop(), [])

  return (
    <div
      ref={ref}
      data-delivery-dial-place="inline"
      className="block w-full pt-2"
      onKeyDown={onKeyDown}
    >
      <div ref={content} className="w-max max-w-full opacity-0">
        {children}
      </div>
    </div>
  )
}
