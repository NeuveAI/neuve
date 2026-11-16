/* ─────────────────────────────────────────────────────────
 * ANIMATION STORYBOARD — Floating margin layers (L1 hint, L2 card, thread)
 *
 * Every margin overlay is anchored to its pin and placed against the
 * viewport (Radix popper = Floating UI autoUpdate): below the pin, start
 * aligned; it flips above when there is no room, shifts to stay 8px inside
 * the viewport, caps its height to the space left (scrolling inside), and
 * follows the pin on scroll, resize, content and layout changes. A pin that
 * scrolls out of view hides its card.
 *
 *    0ms   opens below: opacity 0 → 1, y −4 → 0 (from the pin)
 *    0ms   opens above (flipped): opacity 0 → 1, y +4 → 0 (from the pin)
 *          card/thread 220ms emphasized decelerate; hint 140ms iOS ease-out
 *  close   unmounts (the overlay item swaps back to its pin)
 *  L3      "Open source": the card stays open but hidden under the source
 *          sheet (visibility, no motion); "Back to unit" shows it again
 *
 * Reduced motion: opacity only, 150ms, no transform.
 * ───────────────────────────────────────────────────────── */

import * as React from "react"
import { useAtomValue } from "jotai"
import { ChevronLeftIcon } from "lucide-react"
import {
  Popover as PopoverPrimitive,
  Tooltip as TooltipPrimitive,
} from "radix-ui"

import { Button } from "@workspace/ui/components/button"
import { cn } from "@workspace/ui/lib/utils"
import { sheetMarkerAtom } from "@workspace/ui/neuve/review-desk/atoms"

/** Space kept between a floating layer and the viewport edge (px). */
export const FLOATING_PADDING = 8
/** Gap between the pin and its layer (px). */
export const FLOATING_OFFSET = 6

/** Marks the L3 source sheet and its scrim (source-sheet.tsx). */
export const SOURCE_SHEET_ATTRIBUTE = "data-source-sheet"

/**
 * The desk closed the expanded layer on an outside press
 * (review-desk-screen.tsx): focus stays where the press put it, as after a
 * press Radix sees itself. Cleared when a card closes, or by the next key
 * press, so a later Escape still returns focus to the pin.
 */
let pressedOutside = false

export function notePressOutside() {
  pressedOutside = true
  window.addEventListener(
    "keydown",
    () => {
      pressedOutside = false
    },
    { capture: true, once: true }
  )
}

/**
 * How the reader last acted: a layer opened by a pointer takes focus
 * without a focus ring, one opened from the keyboard shows it. Browsers
 * guess this for programmatic focus; the guess is made explicit here.
 */
let lastInput: "pointer" | "keyboard" = "pointer"
if (typeof window !== "undefined") {
  window.addEventListener(
    "pointerdown",
    () => {
      lastInput = "pointer"
    },
    true
  )
  window.addEventListener(
    "keydown",
    () => {
      lastInput = "keyboard"
    },
    true
  )
}

/**
 * Focus an element inside a layer as the reader's last input would: with a
 * ring after a key press, without one after a pointer press. Stable, so it
 * works as a ref callback that focuses only when its element mounts.
 */
export function focusAsLastInput(element: HTMLElement | null) {
  element?.focus({ focusVisible: lastInput === "keyboard" })
}

/** A card chosen from a line's list: its back control names the list. */
export interface CardBack {
  /** e.g. "Back to 5 markers". */
  label: string
  onBack: () => void
}

/**
 * Leads a card's header, where a reader looks for "back"; the same quiet
 * icon button as the card's Close, so the row keeps its rhythm. The chosen
 * row unmounts when the card swaps in, so focus lands here, the card's
 * first control, as it does on a card opened from its pin.
 */
export function CardBackButton({ back }: { back: CardBack }) {
  return (
    <Button
      ref={focusAsLastInput}
      type="button"
      variant="quiet"
      size="icon-card"
      aria-label={back.label}
      data-card-back=""
      onClick={back.onBack}
      className="size-[26px] shrink-0"
    >
      <ChevronLeftIcon aria-hidden="true" className="size-[14px]" />
    </Button>
  )
}

/** What Radix would focus first when a layer opens: its first tabbable. */
const TABBABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/** The event came from the source sheet opened from this card. */
function fromSourceSheet(event: { target: EventTarget | null }): boolean {
  return (
    event.target instanceof Element &&
    event.target.closest(`[${SOURCE_SHEET_ATTRIBUTE}]`) !== null
  )
}

/**
 * The open card, so a tooltip inside it (the graph path) can keep itself
 * inside the card's box.
 */
export const CardBoundaryContext = React.createContext<
  React.RefObject<HTMLElement | null>
>({ current: null })

/**
 * L2 card or thread, anchored to the pin wrapped in `PopoverPrimitive.Anchor`
 * under the same `PopoverPrimitive.Root`. Portaled to the body, so the
 * shadow-DOM overlay never clips it.
 */
export function FloatingCard({
  label,
  description,
  onEscape,
  onKeyDown,
  onReturnFocus,
  passive = false,
  children,
}: {
  label: string
  /** Read after the name, e.g. the lines the card is about. */
  description?: string
  /**
   * Escape inside the layer. Calling `preventDefault` keeps the layer open
   * (a step back inside it instead of a close).
   */
  onEscape?: (event: KeyboardEvent) => void
  /**
   * Keys pressed in the layer, its own box included (focus lands on the box
   * when nothing inside it is in view), e.g. a card's F for feedback.
   */
  onKeyDown?: React.KeyboardEventHandler<HTMLDivElement>
  /** Focus goes back to the pin when the card closes from the keyboard. */
  onReturnFocus: () => void
  /** Previews shown together do not move focus away from the review controls. */
  passive?: boolean
  children: React.ReactNode
}) {
  const boundary = React.useRef<HTMLDivElement | null>(null)
  const descriptionId = React.useId()
  // How the layer was dismissed. Focus returns to the pin only after a
  // keyboard dismissal (Escape): a pointer press or a Tab elsewhere already
  // put the reviewer where they meant to be, and a programmatic focus there
  // would show the pin's focus ring and peek (context-markers.md rule 6).
  const leftByPointerOrFocus = React.useRef(false)
  // "Open source" keeps the card: it waits, hidden, under the L3 sheet, and
  // "Back to unit" returns to it.
  const underSheet = useAtomValue(sheetMarkerAtom) !== null
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        ref={boundary}
        side="bottom"
        align="start"
        sideOffset={FLOATING_OFFSET}
        collisionPadding={FLOATING_PADDING}
        avoidCollisions
        sticky="partial"
        hideWhenDetached
        // The pin moves without scrolling or resizing anything (the overlay
        // re-places items with transforms on wrap, split, hunk expansion):
        // re-measure every frame while open.
        updatePositionStrategy="always"
        aria-label={label}
        aria-describedby={description ? descriptionId : undefined}
        data-floating-card=""
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          if (passive) return
          // Focus moves into the layer either way (accessibility); the ring
          // shows only when the reader is on the keyboard.
          focusAsLastInput(
            boundary.current?.querySelector<HTMLElement>(TABBABLE) ??
              boundary.current
          )
        }}
        onKeyDown={onKeyDown}
        onEscapeKeyDown={(event) => {
          leftByPointerOrFocus.current = false
          onEscape?.(event)
        }}
        // Focus came back into the card (for example the trigger after
        // "Back to unit"): a later keyboard close returns focus to the pin.
        onFocus={() => {
          leftByPointerOrFocus.current = false
        }}
        // The source sheet opened from this card is not outside it: pressing
        // or focusing there must not dismiss the card.
        onPointerDownOutside={(event) => {
          if (fromSourceSheet(event)) event.preventDefault()
          else leftByPointerOrFocus.current = true
        }}
        onFocusOutside={(event) => {
          if (fromSourceSheet(event)) event.preventDefault()
          else leftByPointerOrFocus.current = true
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          const byPress = pressedOutside
          pressedOutside = false
          if (!passive && !leftByPointerOrFocus.current && !byPress)
            onReturnFocus()
        }}
        // Hidden, it is also out of the tab order and the accessibility tree.
        aria-hidden={underSheet || undefined}
        className={cn(
          "nv-floating z-40 box-border flex max-h-(--radix-popover-content-available-height) w-[min(300px,calc(100vw-16px))] flex-col overflow-x-hidden overflow-y-auto overscroll-contain rounded-xl bg-surface shadow-card outline-none",
          underSheet && "invisible"
        )}
      >
        {description && (
          <span id={descriptionId} className="sr-only">
            {description}
          </span>
        )}
        <CardBoundaryContext.Provider value={boundary}>
          {children}
        </CardBoundaryContext.Provider>
      </PopoverPrimitive.Content>
    </PopoverPrimitive.Portal>
  )
}

/**
 * L1 hint under a pin (or above it near the bottom), anchored through the
 * pin's `TooltipPrimitive.Trigger`. Opens only from our own real-hover /
 * focus-visible state; it never takes pointer events.
 */
export function FloatingHint({
  children,
  label,
  side = "bottom",
  align = "start",
  boundary,
  onEscape,
}: {
  children: React.ReactNode
  /** What assistive tech reads (Radix keeps a visually hidden copy). */
  label: string
  side?: "bottom" | "top"
  align?: "start" | "end"
  /** Keep inside this element too (the graph path stays inside its card). */
  boundary?: HTMLElement | null
  /**
   * Escape while it shows: a hint whose owner holds it open ends it here.
   * The press is the hint's alone (as the source sheet's is): it goes no
   * further, so the desk closes nothing else with it and, embedded, Ace
   * does not take it either.
   */
  onEscape?: () => void
}) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        side={side}
        align={align}
        sideOffset={side === "top" ? 2 : FLOATING_OFFSET}
        collisionPadding={FLOATING_PADDING}
        collisionBoundary={boundary ?? undefined}
        avoidCollisions
        sticky="always"
        hideWhenDetached
        updatePositionStrategy="always"
        aria-label={label}
        data-floating-hint=""
        onEscapeKeyDown={
          onEscape &&
          ((event) => {
            event.stopPropagation()
            onEscape()
          })
        }
        className="nv-floating nv-floating-hint pointer-events-none z-50 max-w-(--radix-tooltip-content-available-width)"
      >
        {children}
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  )
}
