import { atom, useAtomValue } from "jotai"

import {
  DELIVERY_STOPS,
  clampDeliveryStop,
  deliveryStopIndex,
  offeredStops,
  resolveDeliveryStop,
  unitDeliveryOverrideAtom,
  useDeliverySettings,
} from "@workspace/ui/neuve/shared/delivery"
import type {
  DeliveryLanguage,
  DeliveryPayload,
  DeliverySettings,
  DeliveryStop,
} from "@workspace/ui/neuve/shared/delivery"

/**
 * Desk-side state for review delivery. The stop resolves from the workspace
 * setting (refined by the payload's declared language) unless the reader
 * moved the dial for this unit. Nothing here is persisted or recorded.
 */

/**
 * The last move of the desk dial: a new object per move, so the phased
 * layers of one change share one morph (phased-layer.tsx).
 */
export interface DeliveryMove {
  unitId: string
  from: DeliveryStop
  to: DeliveryStop
}
export const deliveryMoveAtom = atom<DeliveryMove | null>(null)

/**
 * Where the reader was when they moved the dial: the diff's top in the
 * viewport, recorded only when they had scrolled into the diff. The diff
 * restores it after the layers above change, so the line they were reading
 * stays put (round-4.md: keep the topmost visible row anchored).
 */
export const deliveryAnchorAtom = atom<{ unitId: string; top: number } | null>(
  null
)

/**
 * Round 7: the title's delivery glyph is out of view (scrolled out of the
 * desk's column, or the page). While it is, the decision dock shows the same
 * glyph. One IntersectionObserver writes it: the title dial's own
 * (DeliveryTitleDial `onAway`, wired by DeliveryTitleGlyph).
 */
export const deliveryTitleAwayAtom = atom(false)

/**
 * A delivery dial closed because its glyph scrolled away while focus was in
 * it: focus goes to the other glyph once that one shows (the dock's, as it
 * arrives). `ring` keeps the keyboard ring. Taken once, by the glyph named.
 */
export const deliveryGlyphFocusAtom = atom<{
  to: "dock"
  ring: boolean
} | null>(null)

/**
 * The dock's dial was open, with focus in it or not, when its dock bar was
 * replaced by another rest bar (a stop change swaps the human rest for the
 * suggested one at Guided). The next dock glyph to mount in that same commit
 * reopens it, so choosing a stop never closes it. Cleared after the commit.
 */
export const deliveryDockDialCarryAtom = atom<{
  focus: { ring: boolean } | null
} | null>(null)

/**
 * Human-suggested at Guided: which units have the "Why" disclosure in the
 * agent's review card open. Per unit, so opening it on one unit doesn't open
 * it on the next.
 */
export const whyOpenAtom = atom<Record<string, boolean>>({})

export const toggleWhyAtom = atom(null, (get, set, unitId: string) => {
  const open = get(whyOpenAtom)
  set(whyOpenAtom, { ...open, [unitId]: !open[unitId] })
})

/**
 * The agent's review line after the unlinked line's "the agent's review"
 * was followed: scrolled to, then tinted like a diff landing. `fade` holds
 * and fades; `static` (reduced motion) stays until the next pointer or key
 * press. The tint shows once the scroll has arrived.
 */
export interface ReviewLanding {
  unitId: string
  /** Changes on every jump, so a repeat restarts the tint. */
  nonce: number
  tint: "fade" | "static"
  arrived: boolean
}

export const reviewLandingAtom = atom<ReviewLanding | null>(null)

let reviewLandingSequence = 0

/** Start a jump to the unit's review line: the tint waits for arrival. */
export const landOnReviewAtom = atom(
  null,
  (_get, set, input: { unitId: string; reduced: boolean }) => {
    reviewLandingSequence += 1
    const landing: ReviewLanding = {
      unitId: input.unitId,
      nonce: reviewLandingSequence,
      tint: input.reduced ? "static" : "fade",
      arrived: false,
    }
    set(reviewLandingAtom, landing)
    return landing.nonce
  }
)

/** The scroll for jump `nonce` has settled: its tint shows. */
export const reviewArrivedAtom = atom(null, (get, set, nonce: number) => {
  const landing = get(reviewLandingAtom)
  if (landing?.nonce === nonce && !landing.arrived)
    set(reviewLandingAtom, { ...landing, arrived: true })
})

/** Jump `nonce`'s tint is over (faded, or the reader acted). */
export const clearReviewLandingAtom = atom(null, (get, set, nonce: number) => {
  if (get(reviewLandingAtom)?.nonce === nonce) set(reviewLandingAtom, null)
})

/**
 * Whether the agent's review mark shows its provenance, per unit. The
 * tooltip reports every open and close (hover, focus, blur, Escape, a press
 * outside); a jump to the review line opens it on arrival, after those.
 */
export const provenanceOpenAtom = atom<Record<string, boolean>>({})

export const setProvenanceOpenAtom = atom(
  null,
  (get, set, input: { unitId: string; open: boolean }) => {
    const current = get(provenanceOpenAtom)
    if ((current[input.unitId] ?? false) === input.open) return
    set(provenanceOpenAtom, { ...current, [input.unitId]: input.open })
  }
)

/** The Guided evidence pin whose excerpt is open ("criterionId:index"). */
export const openExcerptAtom = atom<string | null>(null)

export const toggleExcerptAtom = atom(null, (get, set, key: string) => {
  set(openExcerptAtom, get(openExcerptAtom) === key ? null : key)
})

/**
 * The reader moves the dial for one unit. Moving back to the stop the
 * workspace resolves (or the stop it shows on this unit, when the unit
 * doesn't offer that one) clears the override, so the unit follows the
 * setting again.
 */
export const setUnitDeliveryStopAtom = atom(
  null,
  (
    get,
    set,
    input: {
      unitId: string
      language: DeliveryLanguage | undefined
      stop: DeliveryStop
      /** The workspace setting the desk reads (its settings atom's value). */
      settings: DeliverySettings
      /** The stops the unit offers (`offeredStops`); absent, all four. */
      offered?: ReadonlyArray<DeliveryStop>
    }
  ) => {
    const settings = input.settings
    const offered = input.offered ?? DELIVERY_STOPS
    const overrides = get(unitDeliveryOverrideAtom)
    const from = clampDeliveryStop(
      resolveDeliveryStop(settings, input.language, overrides[input.unitId]),
      offered
    )
    const base = resolveDeliveryStop(settings, input.language)
    const next = { ...overrides }
    if (input.stop === base || input.stop === clampDeliveryStop(base, offered))
      delete next[input.unitId]
    else next[input.unitId] = input.stop
    set(unitDeliveryOverrideAtom, next)
    set(deliveryMoveAtom, { unitId: input.unitId, from, to: input.stop })
    if (input.stop !== "guided") {
      set(openExcerptAtom, null)
      const why = { ...get(whyOpenAtom) }
      delete why[input.unitId]
      set(whyOpenAtom, why)
    }
  }
)

/**
 * The stop a unit shows: the reader's override, else the setting (refined
 * by language), held to the stops the payload offers. A stop the unit
 * doesn't offer shows the deepest offered stop below it, so no unit opens on
 * a stop with nothing to show; what the reader stored is untouched, and a
 * unit that offers it opens there.
 */
export function shownDeliveryStop(
  settings: DeliverySettings,
  overrides: Readonly<Record<string, DeliveryStop>>,
  unitId: string,
  payload: DeliveryPayload
): DeliveryStop {
  return clampDeliveryStop(
    resolveDeliveryStop(settings, payload.language, overrides[unitId]),
    offeredStops(payload)
  )
}

/**
 * The unit's shown stop and its index (the storyboard's stage), with the
 * stop the reader's override or setting asked for before it was held to
 * the offered stops. Every reader of the stop (briefing, layers, diff,
 * dock, dial ticks) reads it here, so they all see the same one.
 */
export function useDeliveryStop(
  unitId: string,
  payload: DeliveryPayload | undefined
): { stop: DeliveryStop; stage: number; asked: DeliveryStop } | null {
  // Sees a storage-backed setting read on mount (jotai 3, see the contract).
  const settings = useDeliverySettings()
  const overrides = useAtomValue(unitDeliveryOverrideAtom)
  if (!payload) return null
  const stop = shownDeliveryStop(settings, overrides, unitId, payload)
  const asked = resolveDeliveryStop(
    settings,
    payload.language,
    overrides[unitId]
  )
  return { stop, stage: deliveryStopIndex(stop), asked }
}
